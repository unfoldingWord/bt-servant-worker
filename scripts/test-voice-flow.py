#!/usr/bin/env python3
"""
Test audio flows end-to-end against bt-servant-worker.

Two modes:
  voice  — Simulates a user sending a voice message. Text is converted to
           speech via OpenAI TTS, base64-encoded, and sent as message_type=audio.
           Tests the full STT → Claude (voice prompt) → TTS pipeline.

  text   — Sends a plain text message that should trigger Claude to call the
           request_audio tool (e.g., "I want to listen to Genesis 1:1").
           Tests the text → Claude (request_audio tool) → TTS pipeline.

Usage:
  # Voice-to-voice flow
  python scripts/test-voice-flow.py voice \
    --worker-url https://staging-api.btservant.ai \
    --worker-key <ENGINE_API_KEY> \
    --openai-key <OPENAI_API_KEY> \
    --text "What does Genesis chapter 1 verse 1 say?"

  # Text-to-audio flow
  python scripts/test-voice-flow.py text \
    --worker-url https://staging-api.btservant.ai \
    --worker-key <ENGINE_API_KEY> \
    --text "I want to listen to an audio reading of Genesis chapter 1 verse 1"

Requirements:
  pip install openai requests
"""

import argparse
import base64
import json
import sys
import time
from pathlib import Path

try:
    import openai
    import requests
except ImportError:
    print("Missing dependencies. Run: pip install openai requests")
    sys.exit(1)


def text_to_audio_base64(text: str, api_key: str, voice: str = "alloy") -> tuple[str, str]:
    """Convert text to speech via OpenAI TTS. Returns (base64_audio, format)."""
    print(f"[TTS] Generating speech for: {text[:80]}...")
    client = openai.OpenAI(api_key=api_key)

    response = client.audio.speech.create(
        model="gpt-4o-mini-tts",
        voice=voice,
        input=text,
        response_format="opus",
    )

    audio_bytes = response.read()
    audio_b64 = base64.b64encode(audio_bytes).decode("utf-8")
    print(f"[TTS] Generated {len(audio_bytes)} bytes of audio ({len(audio_b64)} base64 chars)")
    return audio_b64, "ogg"


def send_chat_request(
    worker_url: str,
    worker_key: str,
    message_type: str,
    user_id: str = "test-voice-flow",
    message: str | None = None,
    audio_b64: str | None = None,
    audio_format: str | None = None,
    org: str | None = None,
    lang_hint: str | None = None,
) -> dict:
    """Send a chat request to bt-servant-worker and parse the SSE response."""
    url = f"{worker_url.rstrip('/')}/api/v1/chat"

    body: dict = {
        "user_id": user_id,
        "client_id": "test-voice-flow",
        "message_type": message_type,
    }
    if message_type == "audio":
        body["audio_base64"] = audio_b64
        body["audio_format"] = audio_format
    else:
        body["message"] = message
    if org:
        body["org"] = org
    if lang_hint:
        body["response_language_hint"] = lang_hint

    headers = {
        "Authorization": f"Bearer {worker_key}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    }

    print(f"[WORKER] POST {url}")
    print(f"[WORKER] message_type={message_type}", end="")
    if message_type == "audio":
        print(f", audio={len(audio_b64)} base64 chars, format={audio_format}")
    else:
        print(f", message={message[:80]}...")

    start = time.time()
    response = requests.post(url, json=body, headers=headers, stream=True, timeout=300)
    response.encoding = "utf-8"

    if response.status_code != 200:
        print(f"[ERROR] HTTP {response.status_code}: {response.text[:500]}")
        sys.exit(1)

    # Parse SSE stream
    result = None
    for line in response.iter_lines(decode_unicode=True):
        if not line or not line.startswith("data: "):
            continue
        data_str = line[6:]  # strip "data: "
        try:
            event = json.loads(data_str)
        except json.JSONDecodeError:
            continue

        event_type = event.get("type", "")
        if event_type == "status":
            print(f"  [status] {event.get('message', '')}")
        elif event_type == "progress":
            pass  # suppress chunked streaming output
        elif event_type == "complete":
            result = event.get("response", {})
            elapsed = time.time() - start
            print(f"  [complete] Response received in {elapsed:.1f}s")
        elif event_type == "error":
            print(f"  [ERROR] {event.get('error', 'unknown error')}")
            sys.exit(1)

    if not result:
        print("[ERROR] No complete event received in SSE stream")
        sys.exit(1)

    return result


def download_audio(url: str, api_key: str, output_path: Path) -> None:
    """Download audio from the worker's R2 storage."""
    print(f"[DOWNLOAD] Fetching audio from {url}...")
    headers = {"Authorization": f"Bearer {api_key}"}
    response = requests.get(url, headers=headers, timeout=30)
    if response.status_code != 200:
        print(f"[ERROR] HTTP {response.status_code} fetching audio")
        sys.exit(1)

    output_path.write_bytes(response.content)
    size_kb = len(response.content) / 1024
    print(f"[DOWNLOAD] Saved {size_kb:.1f} KB to {output_path}")


def show_results(result: dict, worker_key: str, mode: str, lang: str | None, output: str | None):
    """Display results and download audio if available."""
    print("\n=== Results ===\n")
    responses = result.get("responses", [])
    voice_url = result.get("voice_audio_url")
    resp_lang = result.get("response_language", "?")

    print(f"Mode: {mode}")
    print(f"Response language: {resp_lang}")
    print(f"Response count: {len(responses)}")
    print(f"Has audio: {'yes' if voice_url else 'no'}")
    for i, resp in enumerate(responses):
        print(f"\n--- Response {i + 1} ---")
        print(resp)

    if voice_url:
        print(f"\nVoice audio URL: {voice_url}")

        timestamp = int(time.time())
        lang_suffix = f"_{lang}" if lang else ""
        output_path = Path(output or f"voice_response_{mode}_{timestamp}{lang_suffix}.opus")

        print(f"\n=== Download audio response ===\n")
        download_audio(voice_url, worker_key, output_path)
        print(f"\nPlay with: ffplay {output_path}")
        print(f"Or open in VLC / any media player that supports Opus")
    else:
        print("\n[WARN] No voice_audio_url in response")
        if mode == "text":
            print("Claude may not have called request_audio. Try a more explicit prompt")
            print('like: "I want to listen to an audio reading of Genesis 1:1"')
        else:
            print("TTS may have failed — check worker logs")


def cmd_voice(args):
    """Voice-to-voice flow: text → TTS → base64 audio → worker → audio response."""
    if not args.openai_key:
        print("[ERROR] --openai-key is required for voice mode (to generate the simulated recording)")
        sys.exit(1)

    print("\n=== Step 1: Simulate voice recording (text → TTS → base64) ===\n")
    audio_b64, audio_format = text_to_audio_base64(args.text, args.openai_key, args.voice)

    print("\n=== Step 2: Send voice message to worker ===\n")
    result = send_chat_request(
        worker_url=args.worker_url,
        worker_key=args.worker_key,
        message_type="audio",
        audio_b64=audio_b64,
        audio_format=audio_format,
        user_id=args.user_id,
        org=args.org,
        lang_hint=args.lang,
    )

    show_results(result, args.worker_key, "voice", args.lang, args.output)


def cmd_text(args):
    """Text-to-audio flow: text message → worker (request_audio tool) → audio response."""
    print("\n=== Send text message to worker ===\n")
    result = send_chat_request(
        worker_url=args.worker_url,
        worker_key=args.worker_key,
        message_type="text",
        message=args.text,
        user_id=args.user_id,
        org=args.org,
        lang_hint=args.lang,
    )

    show_results(result, args.worker_key, "text", args.lang, args.output)


def main():
    parser = argparse.ArgumentParser(
        description="Test audio flows against bt-servant-worker",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    subparsers = parser.add_subparsers(dest="mode", required=True)

    # Shared arguments
    shared = argparse.ArgumentParser(add_help=False)
    shared.add_argument("--worker-url", required=True, help="Staging worker URL")
    shared.add_argument("--worker-key", required=True, help="ENGINE_API_KEY for the worker")
    shared.add_argument("--text", required=True, help="Text content (spoken for voice, sent as-is for text)")
    shared.add_argument("--lang", default=None, help="Response language hint (e.g., es, fr, pt)")
    shared.add_argument("--user-id", default="test-voice-flow", help="User ID for the request")
    shared.add_argument("--org", default=None, help="Organization override")
    shared.add_argument("--output", default=None, help="Output file path (default: auto-generated)")

    # Voice subcommand
    voice_parser = subparsers.add_parser("voice", parents=[shared], help="Voice-to-voice flow")
    voice_parser.add_argument("--openai-key", required=True, help="OpenAI API key for TTS")
    voice_parser.add_argument("--voice", default="alloy", help="OpenAI TTS voice (default: alloy)")

    # Text subcommand
    subparsers.add_parser("text", parents=[shared], help="Text-to-audio flow")

    args = parser.parse_args()

    if args.mode == "voice":
        cmd_voice(args)
    elif args.mode == "text":
        cmd_text(args)


if __name__ == "__main__":
    main()

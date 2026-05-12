# Spoken-Mode Demo Script (Telegram)

A step-by-step walkthrough for recording a video demo of spoken-mode in Telegram. Every line you type or say is written out verbatim. Designed to flow as a natural 8-12 minute conversation.

## Pre-recording Setup

1. **Telegram group** with @bt_servant added as a member. Name it something like "Spoken Mode Demo."
2. **spoken-mode activated** on the group via admin API:
   ```bash
   curl -s -X PUT \
     -H "Authorization: Bearer $API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"mode": "spoken-mode"}' \
     "$BASE_URL/api/v1/admin/orgs/$ORG/groups/$CHAT_ID/mode"
   ```
3. **Clean state** — clear history and memory if the group was used before:
   ```bash
   curl -X DELETE -H "Authorization: Bearer $API_KEY" \
     "$BASE_URL/api/v1/admin/orgs/$ORG/groups/$CHAT_ID/history"
   curl -X DELETE -H "Authorization: Bearer $API_KEY" \
     "$BASE_URL/api/v1/admin/orgs/$ORG/groups/$CHAT_ID/memory"
   ```
4. **Ideal:** 2-3 real people in the group so you have multiple speakers. If solo, it still works — the bot tracks you by your Telegram display name.
5. **Have a passage in mind.** This script uses **Luke 5:1-11** (Jesus calling the first disciples at the lake). It's 11 verses but the bot accepts it. If you want a shorter one, **Mark 1:16-20** (5 verses, same story) works too.
6. Start your screen recorder (Loom, OBS, etc.)

---

## Act 1: First Contact (~2 min)

**What you're showing:** The bot activates in spoken-mode immediately — no generic intro, no menu.

### Step 1 — Open the conversation

Type in the Telegram group:

> @bt_servant we're ready to begin

**Wait for the bot to respond.** It should greet the group warmly and ask who the leaders or trainers are. It should NOT introduce itself as "BT Servant" or offer a list of features/modes.

**Voiceover idea:** "The bot is already in spoken-mode. It doesn't offer a menu or ask what we want to do — it goes straight into the workflow."

### Step 2 — Identify the leader

Type:

> I'm the leader. My name is Ian.

_(Use your real name.)_

**Wait for the bot to respond.** It should acknowledge you by name, then introduce the story collection phase — asking the group to share short personal stories by voice message.

---

## Act 2: Story Collection (~3 min)

**What you're showing:** Voice message processing, theme extraction, and the ambient text filter (the bot stays silent when not addressed).

### Step 3 — Share a voice story

**Record a voice message in Telegram** (hold the mic button). Say something like:

> "When I was a kid, my grandfather used to take me fishing before sunrise. We'd sit in his little boat on the lake and he'd tell me the names of all the fish. He said you have to be patient — the fish come when they're ready, not when you are."

_(Speak naturally, ~15 seconds. The specific content doesn't matter much — just make it vivid and personal. Fishing/water/family themes work well because they'll connect to Luke 5 later.)_

**Wait for the bot to respond.** It should:

- Send a voice message (TTS) acknowledging you by name
- Reflect back key imagery ("I noticed the image of the boat at dawn...")
- Extract themes (patience, tradition, water, family)
- Ask if anyone else wants to share

**Voiceover idea:** "The bot transcribed the voice message, extracted themes and imagery, and stored everything — including the original audio recording — in persistent memory."

### Step 4 — Show ambient text filtering

**Important: Do NOT @mention the bot.** Just type casually in the group:

> great memories!

**Wait 5-10 seconds.** The bot should say absolutely nothing. No response at all.

**Voiceover idea:** "That message wasn't addressed to the bot, so it stays completely silent. The message is still saved in the conversation history for context, but the bot never calls Claude — this is handled in code, not by asking the AI to be quiet."

### Step 5 — Second voice story (optional but recommended)

If you have a second person in the group, have them record a voice message:

> "My grandmother was a weaver. She could look at the sky and tell you what the weather would be tomorrow. She said the patterns in the clouds are like the patterns in cloth — God is the one weaving them both."

If solo, record it yourself — the bot tracks by speaker name so it still works.

**Wait for the bot to respond.** Same pattern — acknowledgement, themes, prompt for more.

### Step 6 — Move on from stories

Type:

> @bt_servant that's all the stories, we're ready to move on

**Wait for the bot to respond.** It should propose 2-4 scripture passages, each 10 verses or fewer, each tied to the themes from your stories (fishing, patience, dawn, family wisdom, etc.).

---

## Act 3: Passage Selection (~1 min)

**What you're showing:** Theme-grounded passage proposals and group choice.

### Step 7 — Pick a passage

The bot will propose several passages. Pick one. If Luke 5:1-11 is offered, go with it. If not, just pick whichever one sounds good. Type:

> Let's go with Luke 5:1-11

_(Or whatever passage you're choosing.)_

**Wait for the bot to respond.** It should confirm the selection, create the passage in memory, and transition to exegesis — "Now we work the meaning of this passage together."

**Voiceover idea:** "Every passage suggestion was grounded in what the group actually shared — the fishing, the patience, the grandparents. These aren't random Bible verses."

---

## Act 4: Exegesis (~3 min)

**What you're showing:** The four narrative discussion points (People, Places, Events, Feelings), with contributions saved and attributed by speaker.

_The lines below assume Luke 5:1-11. If you picked a different passage, adapt accordingly — just name the people, places, events, and feelings in that passage._

### Step 8 — People

Type:

> Let's start with People.

**Wait for the bot to respond.** It will open the discussion. Then type:

> Jesus is teaching by the lake. Simon Peter is a fisherman — he's been out all night with nothing to show for it. James and John are his partners, working with their father Zebedee's boats.

**Wait for the bot to save and respond.**

### Step 9 — Places

Type:

> Now Places.

**Wait for the bot to respond.** Then type:

> The Lake of Gennesaret. It's a working lake, not a scenic backdrop. These men earned their living on this water. They knew every current, every shallow spot.

**Wait for the bot to save and respond.**

### Step 10 — Events

Type:

> Events.

**Wait for the bot to respond.** Then type:

> Jesus borrows Simon's boat to teach from. Then he tells Simon to go into deep water and drop the nets. Simon says they fished all night and caught nothing, but does it anyway. The catch is so huge the nets start breaking. Both boats nearly sink. Simon falls at Jesus' knees and says "Go away from me, Lord — I'm a sinful man." Then Jesus says "Don't be afraid. From now on you'll be catching people." They leave everything and follow him.

**Wait for the bot to save and respond.**

### Step 11 — Feelings

Type:

> Feelings.

**Wait for the bot to respond.** Then type:

> Simon must have been exhausted after fishing all night with nothing. Then total astonishment when the nets are breaking with fish. Then fear — real fear — when he realizes who Jesus is. And then somehow, courage. He walks away from everything he knows.

**Wait for the bot to save and respond.**

### Step 12 — Advance to internalization

Type:

> We're ready for the next step.

**Wait for the bot to respond.** It should advance to internalization and present the four method options: drama, storyboarding, random objects, or oral re-narration.

**Voiceover idea:** "Every contribution was saved to memory with speaker attribution. If this group comes back next week, all of this context is still there."

---

## Act 5: Internalization + Drafting (~2 min)

**What you're showing:** Method selection, the drafting workflow, and draft acceptance.

### Step 13 — Pick a method

Type:

> Let's do drama.

**Wait for the bot to respond.** It will give instructions for acting out the passage.

### Step 14 — Debrief

Type:

> We acted it out twice. The second time, when Simon fell at Jesus' knees, the person playing Jesus just stood there quietly. Nobody knew what to say. That silence said everything.

**Wait for the bot to save and respond.**

### Step 15 — Advance to drafting

Type:

> We're ready for the next step.

**Wait for the bot to respond.** It should transition to drafting — instructions for recording an oral draft.

### Step 16 — Record a draft

**Record a voice message** — retell the passage in your own words. Don't read it, just tell it like a story. Something like:

> "One day a huge crowd was pressing in on Jesus by the lake. He got into Simon's boat and taught from the water. When he finished, he told Simon to go deep and drop the nets. Simon said, Master, we worked all night and caught nothing — but if you say so, I'll do it. And the catch was so enormous the nets were tearing apart. They called for help and filled both boats until they were sinking. Simon fell at Jesus' feet and said, Go away from me Lord, I am a sinful man. But Jesus said, Don't be afraid. From now on you'll catch people. And they pulled the boats up on shore, left everything, and followed him."

_(~30 seconds. Don't stress about getting it perfect — the self-check process handles that.)_

**Wait for the bot to respond.** It should play the draft back and ask the self-check questions.

### Step 17 — Accept the draft

Type:

> Nothing added, nothing taken away, and it sounds natural. Let's go with it.

**Wait for the bot to respond.** The draft should be accepted and the bot transitions to community check.

**Voiceover idea:** "The draft recording, acceptance status, and self-check notes were all saved to memory in the same turn — no risk of partial state."

---

## Act 6: Story Replay (~30 sec)

**What you're showing:** The bot can retrieve and play back original voice recordings from memory.

### Step 18 — Ask for a replay

Type:

> @bt_servant can you play my story again?

_(Or "Can you play Ian's story again?" using your name.)_

**Wait for the bot to respond.** It should attach the **original voice recording** — the actual audio you recorded in Step 3, not a text-to-speech recreation.

**Voiceover idea:** "That's my actual voice from earlier — not a TTS recreation. The bot found the R2 storage key in memory and served the original recording."

---

## Closing (~30 sec)

Stop screen recording. Add a voiceover wrap-up if desired:

- "This entire conversation is persistent. The group can close Telegram, come back next week, and pick up exactly where they left off."
- "Every contribution is attributed by speaker. Every decision is logged. The translation belongs to the community — the bot is a facilitator and a memory."
- "The full workflow has seven phases: story collection, passage selection, exegesis, internalization, drafting, community check, and consultant review. We walked through the first five today."

---

## If Things Go Wrong

| Problem                                        | What to do                                                                                   |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Bot doesn't respond                            | Wait 30 seconds. If still nothing, type `@bt_servant hello` to wake it up.                   |
| Bot responds as generic BT Servant             | The mode wasn't set. Re-run the admin PUT command from setup.                                |
| Bot gives a markdown-formatted response        | This is a prompt issue, not a blocker. Just keep going — it'll settle into oral style.       |
| Voice message gets a 502                       | Telegram timed out waiting. Just send the voice message again.                               |
| Bot says "I'm having trouble saving to memory" | Just rephrase your message or say "please try saving that again." It usually works on retry. |
| You want to start over                         | Run the DELETE commands from setup to clear history and memory, then begin from Act 1.       |

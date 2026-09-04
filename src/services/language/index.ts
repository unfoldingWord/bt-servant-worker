/**
 * Language services (onion layer): written-language detection for a user turn.
 * May import types/ and utils/; imported by durable-objects/.
 *
 * Only what the consuming layer uses is re-exported. Tests import the tuning
 * constants and strip helpers from ./detect.js directly.
 */
export { detectWrittenLanguage, UNDETERMINED_LANGUAGE, type DetectedLanguage } from './detect.js';

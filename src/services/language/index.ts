/**
 * Language services (onion layer): written-language detection for a user turn.
 * May import types/ and utils/; imported by durable-objects/.
 */
export {
  detectWrittenLanguage,
  stripNonLinguistic,
  MIN_CONFIDENCE,
  MIN_LETTERS,
  type DetectedLanguage,
} from './detect.js';

/** Share QR helpers (#474): codes, links, paths, request gating, due rule, media. */

import { describe, expect, it } from 'vitest';
import type { ChatRequest } from '../../src/types/engine.js';
import type { ChatMode } from '../../src/types/prompt-overrides.js';
import { shareCodeOpensMode } from '../../src/utils/mode-share-code.js';
import {
  buildShareQrLink,
  buildShareQrMedia,
  dueShareQrCode,
  isValidShareCode,
  parseShareQrPath,
  shareQrFlagKey,
  shareQrImagePath,
  shareQrRequestSkip,
} from '../../src/utils/share-qr.js';

const NUMBER = '15558196461';

describe('isValidShareCode', () => {
  it('accepts a slug and an org-qualified slug', () => {
    expect(isValidShareCode('spoken')).toBe(true);
    expect(isValidShareCode('fia-coach')).toBe(true);
    expect(isValidShareCode('wordcollective/bible-study')).toBe(true);
  });
  it('rejects anything else', () => {
    for (const code of ['', 'Spoken', 'a/b/c', '/x', 'x/', '-x', 'x y', '../etc', 'a%2Fb']) {
      expect(isValidShareCode(code)).toBe(false);
    }
  });
});

describe('buildShareQrLink', () => {
  it('builds the bare link for no mode', () => {
    expect(buildShareQrLink('+1 555 819 6461', null)).toBe('https://wa.me/15558196461');
  });
  it('builds the same link as the #311 welcome for a mode', () => {
    expect(buildShareQrLink(NUMBER, 'spoken')).toBe('https://wa.me/15558196461?text=%23spoken');
    expect(buildShareQrLink(NUMBER, 'org/mode')).toBe(
      'https://wa.me/15558196461?text=%23org%2Fmode'
    );
  });
  it('returns null for a bad number, an invalid code or a clear token', () => {
    expect(buildShareQrLink(undefined, null)).toBeNull();
    expect(buildShareQrLink('123', 'spoken')).toBeNull();
    expect(buildShareQrLink(NUMBER, 'Bad Code')).toBeNull();
    expect(buildShareQrLink(NUMBER, 'default')).toBeNull();
  });
});

describe('share QR paths', () => {
  it('round-trips codes through the image path', () => {
    for (const code of [null, 'spoken', 'org/mode']) {
      expect(parseShareQrPath(shareQrImagePath(code))).toEqual({ code });
    }
    expect(shareQrImagePath(null)).toBe('/public/share-qr.png');
    expect(shareQrImagePath('spoken')).toBe('/public/share-qr/spoken.png');
  });
  it('rejects other paths', () => {
    for (const path of [
      '/public/share-qr/',
      '/public/share-qr/.png',
      '/public/share-qr/spoken',
      '/public/share-qr/Spoken.png',
      '/public/share-qr/a/b/c.png',
      '/public/share-qrx.png',
    ]) {
      expect(parseShareQrPath(path)).toBeNull();
    }
  });
});

describe('shareQrFlagKey', () => {
  it('keys per code, with a separate bare key', () => {
    expect(shareQrFlagKey('spoken')).toBe('share_qr_sent:spoken');
    expect(shareQrFlagKey(null)).toBe('share_qr_sent:@bare');
  });
});

describe('shareQrRequestSkip', () => {
  const base: ChatRequest = {
    client_id: 'whatsapp',
    user_id: 'u1',
    message_type: 'text',
    accepts_share_qr: true,
    progress_callback_url: 'https://gw.test/cb',
    message_key: 'k',
  };
  it('allows an opted-in unfoldingWord WhatsApp private callback request', () => {
    expect(shareQrRequestSkip(base, 'unfoldingWord')).toBeNull();
    expect(shareQrRequestSkip({ ...base, chat_type: 'private' }, 'unfoldingWord')).toBeNull();
  });
  it('names the reason for every other request', () => {
    const { accepts_share_qr: _omit, ...notOptedIn } = base;
    expect(shareQrRequestSkip(notOptedIn, 'unfoldingWord')).toBe('not_opted_in');
    expect(shareQrRequestSkip({ ...base, accepts_share_qr: false }, 'unfoldingWord')).toBe(
      'not_opted_in'
    );
    expect(shareQrRequestSkip({ ...base, client_id: 'telegram' }, 'unfoldingWord')).toBe(
      'not_whatsapp'
    );
    const { progress_callback_url: _cb, ...noCallback } = base;
    expect(shareQrRequestSkip(noCallback, 'unfoldingWord')).toBe('not_callback');
    expect(shareQrRequestSkip({ ...base, chat_type: 'group' }, 'unfoldingWord')).toBe('group_chat');
    expect(shareQrRequestSkip(base, 'wordcollective')).toBe('other_org');
    expect(shareQrRequestSkip({ ...base, suppress_welcome: true }, 'unfoldingWord')).toBe(
      'welcome_suppressed'
    );
  });
});

describe('dueShareQrCode', () => {
  it('is due for a mode entered this turn (trigger or switch_mode)', () => {
    expect(dueShareQrCode({ startMode: undefined, endMode: 'a', firstInteraction: false })).toEqual(
      { code: 'a' }
    );
    expect(dueShareQrCode({ startMode: 'a', endMode: 'b', firstInteraction: false })).toEqual({
      code: 'b',
    });
  });
  it('is due for a brand-new user, with or without a mode', () => {
    expect(dueShareQrCode({ startMode: 'a', endMode: 'a', firstInteraction: true })).toEqual({
      code: 'a',
    });
    expect(
      dueShareQrCode({ startMode: undefined, endMode: undefined, firstInteraction: true })
    ).toEqual({ code: null });
  });
  it('is not due on a later turn in the same mode, or when the mode was cleared', () => {
    expect(dueShareQrCode({ startMode: 'a', endMode: 'a', firstInteraction: false })).toBeNull();
    expect(
      dueShareQrCode({ startMode: 'a', endMode: undefined, firstInteraction: false })
    ).toBeNull();
    expect(
      dueShareQrCode({ startMode: undefined, endMode: undefined, firstInteraction: false })
    ).toBeNull();
  });
});

describe('buildShareQrMedia', () => {
  const origin = 'https://api.btservant.ai';
  it('builds the image URL and an English caption ending with the link', () => {
    const qr = buildShareQrMedia({ whatsappNumber: NUMBER, workerOrigin: origin, code: 'spoken', locale: 'en' }); // prettier-ignore
    expect(qr).toEqual({
      url: 'https://api.btservant.ai/public/share-qr/spoken.png',
      caption:
        'Share BT Servant with others: scan this code, or forward this image.\n' +
        'https://wa.me/15558196461?text=%23spoken',
      code: 'spoken',
    });
  });
  it('translates the caption (pt) and falls back to English for other locales', () => {
    const pt = buildShareQrMedia({ whatsappNumber: NUMBER, workerOrigin: origin, code: null, locale: 'pt-BR' }); // prettier-ignore
    expect(pt?.caption.startsWith('Compartilhe o BT Servant')).toBe(true);
    expect(pt?.url).toBe('https://api.btservant.ai/public/share-qr.png');
    const sw = buildShareQrMedia({ whatsappNumber: NUMBER, workerOrigin: origin, code: null, locale: 'sw' }); // prettier-ignore
    expect(sw?.caption.startsWith('Share BT Servant')).toBe(true);
  });
  it('returns null without a valid number, for a clear token, or off HTTPS', () => {
    expect(buildShareQrMedia({ whatsappNumber: undefined, workerOrigin: origin, code: 'a', locale: 'en' })).toBeNull(); // prettier-ignore
    expect(buildShareQrMedia({ whatsappNumber: NUMBER, workerOrigin: origin, code: 'default', locale: 'en' })).toBeNull(); // prettier-ignore
    expect(buildShareQrMedia({ whatsappNumber: NUMBER, workerOrigin: 'http://x', code: 'a', locale: 'en' })).toBeNull(); // prettier-ignore
    expect(buildShareQrMedia({ whatsappNumber: NUMBER, workerOrigin: '', code: 'a', locale: 'en' })).toBeNull(); // prettier-ignore
  });
});

describe('shareCodeOpensMode (pool-level, no KV)', () => {
  const pool: ChatMode[] = [
    { name: 'spoken', published: true, overrides: {} },
    { name: 'draft', published: false, overrides: {} },
    { name: 'team', published: true, requires_group: true, overrides: {} },
    { name: 'spoken-plus', published: true, overrides: {} },
    { name: 'wordcollective/study', published: true, org: 'wordcollective', overrides: {} },
  ];
  it('is true for a published private mode and a qualified foreign mode', () => {
    expect(shareCodeOpensMode('spoken', pool, 'unfoldingWord')).toBe(true);
    expect(shareCodeOpensMode('spoken-plus', pool, 'unfoldingWord')).toBe(true);
    expect(shareCodeOpensMode('wordcollective/study', pool, 'unfoldingWord')).toBe(true);
  });
  it('is false for a draft, a group-only mode, a missing mode or a clear token', () => {
    expect(shareCodeOpensMode('draft', pool, 'unfoldingWord')).toBe(false);
    expect(shareCodeOpensMode('team', pool, 'unfoldingWord')).toBe(false);
    expect(shareCodeOpensMode('gone', pool, 'unfoldingWord')).toBe(false);
    expect(shareCodeOpensMode('default', pool, 'unfoldingWord')).toBe(false);
  });
});

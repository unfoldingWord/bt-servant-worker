import { describe, it, expect } from 'vitest';
import { resolveOrgFromBody, resolveOrgFromParams } from '../../src/utils/org.js';

const DEFAULT = 'default-org';

describe('resolveOrgFromBody', () => {
  it('should use org when present', () => {
    expect(resolveOrgFromBody({ org: 'acme' }, DEFAULT)).toBe('acme');
  });

  it('should use org_id when org is absent', () => {
    expect(resolveOrgFromBody({ org_id: 'acme' }, DEFAULT)).toBe('acme');
  });

  it('should prefer org over org_id when both are present', () => {
    expect(resolveOrgFromBody({ org: 'preferred', org_id: 'legacy' }, DEFAULT)).toBe('preferred');
  });

  it('should fall back to default when neither is present', () => {
    expect(resolveOrgFromBody({}, DEFAULT)).toBe(DEFAULT);
  });
});

describe('resolveOrgFromParams', () => {
  it('should use org when present', () => {
    const params = new URLSearchParams('org=acme');
    expect(resolveOrgFromParams(params, DEFAULT)).toBe('acme');
  });

  it('should use org_id when org is absent', () => {
    const params = new URLSearchParams('org_id=acme');
    expect(resolveOrgFromParams(params, DEFAULT)).toBe('acme');
  });

  it('should prefer org over org_id when both are present', () => {
    const params = new URLSearchParams('org=preferred&org_id=legacy');
    expect(resolveOrgFromParams(params, DEFAULT)).toBe('preferred');
  });

  it('should fall back to default when neither is present', () => {
    const params = new URLSearchParams();
    expect(resolveOrgFromParams(params, DEFAULT)).toBe(DEFAULT);
  });
});

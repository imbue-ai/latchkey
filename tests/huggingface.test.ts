import { describe, it, expect } from 'vitest';
import { HUGGINGFACE } from '../src/services/huggingface.js';
import { BUILTIN_SERVICE_REGISTRY } from './builtinServiceRegistry.js';
import type { Service } from '../src/services/core/base.js';

function primaryServiceForUrl(url: string): Service | null {
  return BUILTIN_SERVICE_REGISTRY.getByUrl(url);
}

describe('Hugging Face URL matching', () => {
  it('matches the Hub API on both hub hostnames', () => {
    expect(primaryServiceForUrl('https://huggingface.co/api/whoami-v2')).toBe(HUGGINGFACE);
    expect(primaryServiceForUrl('https://hf.co/api/models?limit=1')).toBe(HUGGINGFACE);
  });

  it('matches repository file transfers and git endpoints', () => {
    expect(
      primaryServiceForUrl('https://huggingface.co/openai-community/gpt2/resolve/main/config.json')
    ).toBe(HUGGINGFACE);
    expect(
      primaryServiceForUrl(
        'https://huggingface.co/owner/repo.git/info/refs?service=git-upload-pack'
      )
    ).toBe(HUGGINGFACE);
  });

  it('matches the inference router and the dataset viewer', () => {
    expect(primaryServiceForUrl('https://router.huggingface.co/v1/chat/completions')).toBe(
      HUGGINGFACE
    );
    expect(primaryServiceForUrl('https://datasets-server.huggingface.co/rows?dataset=x')).toBe(
      HUGGINGFACE
    );
  });

  // Redirected file transfers are authenticated by the URL itself, so the
  // storage hosts are left to the caller: a bearer header would be pointless
  // there, and the Xet CAS server even rejects the request once it sees a
  // second Authorization header.
  it('does not match the storage hosts that transfers are redirected to', () => {
    expect(
      primaryServiceForUrl('https://us.aws.cdn.hf.co/xet-bridge-us/abc?Expires=1&Signature=x')
    ).toBeNull();
    expect(primaryServiceForUrl('https://cdn-lfs.hf.co/repos/aa/bb/file?Expires=1')).toBeNull();
    expect(primaryServiceForUrl('https://cdn-lfs-us-1.hf.co/repos/aa/bb/file')).toBeNull();
    expect(primaryServiceForUrl('https://cas-server.xethub.hf.co/reconstruction/abc')).toBeNull();
    expect(primaryServiceForUrl('https://transfer.xethub.hf.co/xorbs/default/abc')).toBeNull();
  });

  it('does not match unrelated hosts, including hosted Spaces', () => {
    expect(primaryServiceForUrl('https://myspace.hf.space/api/predict')).toBeNull();
    expect(primaryServiceForUrl('https://hf.co.example.com/api/models')).toBeNull();
  });
});

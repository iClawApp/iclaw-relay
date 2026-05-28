/**
 * Random ID generators for tunnels and per-request correlation.
 *
 * Subdomains use a small adjective + noun + 4-char suffix so the URLs are
 * still memorable but the namespace is wide enough that guessing one is
 * pointless (~30 * 30 * 36^4 ≈ 1.5B combinations). Suffix entropy is the
 * load-bearing part; the words are cosmetic.
 */

import { randomBytes, randomInt } from 'node:crypto';

const ADJECTIVES = [
  'silver', 'amber', 'crimson', 'azure', 'jade', 'ivory', 'velvet', 'frosty',
  'mellow', 'sunny', 'breezy', 'misty', 'quiet', 'lively', 'gentle', 'bright',
  'happy', 'lucky', 'witty', 'brave', 'noble', 'swift', 'humble', 'eager',
  'curious', 'wild', 'cosmic', 'rustic', 'cozy', 'autumn',
];

const NOUNS = [
  'fox', 'otter', 'lynx', 'heron', 'falcon', 'panda', 'owl', 'wren',
  'badger', 'sparrow', 'finch', 'bison', 'meadow', 'river', 'mountain', 'forest',
  'harbor', 'lantern', 'cinder', 'ember', 'comet', 'planet', 'cloud', 'thicket',
  'orchard', 'willow', 'maple', 'cedar', 'pebble', 'beacon',
];

const SUFFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'; // 36 chars

function randomElement<T>(arr: readonly T[]): T {
  return arr[randomInt(0, arr.length)] as T;
}

function randomSuffix(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += SUFFIX_ALPHABET[randomInt(0, SUFFIX_ALPHABET.length)];
  }
  return out;
}

/** "silver-fox-7h3k" style subdomain. */
export function generateSubdomain(): string {
  return `${randomElement(ADJECTIVES)}-${randomElement(NOUNS)}-${randomSuffix(4)}`;
}

/** Short hex id for HTTP request correlation. Never exposed externally. */
export function generateRequestId(): string {
  return `r-${randomBytes(6).toString('hex')}`;
}

/** Short hex id for a public WS stream. Distinct namespace from request ids. */
export function generateStreamId(): string {
  return `s-${randomBytes(6).toString('hex')}`;
}

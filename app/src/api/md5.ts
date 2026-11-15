import * as Crypto from 'expo-crypto';

/** MD5 en hexadecimal de un texto (UTF-8). En PC se usa md5.web.ts: crypto.subtle no ofrece MD5. */
export function md5(text: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.MD5, text);
}

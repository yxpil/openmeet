import { generateKeyPairSync } from 'node:crypto';
import {
  BasicConstraintsExtension,
  ExtendedKeyUsageExtension,
  GeneralName,
  KeyUsagesExtension,
  KeyUsageFlags,
  Name,
  SubjectAlternativeNameExtension,
  X509CertificateGenerator
} from '@peculiar/x509';

export interface SelfSignedPair {
  keyPem: string;
  certPem: string;
}

function toPem(der: Buffer, label: string): string {
  const body = der.toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${body.join('\n')}\n-----END ${label}-----\n`;
}

/**
 * Test-only TLS material, generated at run time so no private key ever lands in
 * the repository and the TLS path is exercised with a real handshake.
 */
export async function createSelfSigned(host = 'localhost'): Promise<SelfSignedPair> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyPem = toPem(
    privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer,
    'PRIVATE KEY'
  );

  const webCrypto = globalThis.crypto as unknown as Crypto;

  const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;
  const publicKeyCryptoKey = await webCrypto.subtle.importKey(
    'jwk',
    { ...jwk, ext: true } as JsonWebKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    true,
    ['verify']
  );
  const privateKeyCryptoKey = await webCrypto.subtle.importKey(
    'jwk',
    { ...(privateKey.export({ format: 'jwk' }) as JsonWebKey), ext: true } as JsonWebKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    true,
    ['sign']
  );

  const now = Math.floor(Date.now() / 1000);
  const certificate = await X509CertificateGenerator.createSelfSigned({
    name: new Name(`CN=${host}`),
    serialNumber: '01',
    notBefore: new Date((now - 60) * 1000),
    notAfter: new Date((now + 3600) * 1000),
    keys: { privateKey: privateKeyCryptoKey, publicKey: publicKeyCryptoKey },
    extensions: [
      new BasicConstraintsExtension(false, 0),
      new KeyUsagesExtension(KeyUsageFlags.digitalSignature | KeyUsageFlags.keyEncipherment),
      new ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1', '1.3.6.1.5.5.7.3.2']),
      new SubjectAlternativeNameExtension([
        new GeneralName('dns', host),
        new GeneralName('ip', '127.0.0.1')
      ])
    ]
  });

  return { keyPem, certPem: `${certificate.toString('pem')}\n` };
}

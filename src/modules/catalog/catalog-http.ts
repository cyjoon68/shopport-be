const providerTimeoutMilliseconds = 10_000;
const maximumResponseBytes = 1024 * 1024;

const cancelBody = (response: Response): Promise<void> =>
  response.body?.cancel().catch(() => undefined) ?? Promise.resolve();

export const fetchCatalogJson = async (
  fetchImpl: typeof fetch,
  url: URL,
): Promise<unknown> => {
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(providerTimeoutMilliseconds),
  });
  if (!response.ok) {
    await cancelBody(response);
    throw new Error(`Catalog request failed: ${String(response.status)}`);
  }
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null &&
    Number(declaredLength) > maximumResponseBytes
  ) {
    await cancelBody(response);
    throw new Error('Catalog response too large');
  }
  if (!response.body) throw new Error('Catalog response has no body');
  const reader = response.body.getReader();
  const chunks: Array<Buffer> = [];
  let size = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > maximumResponseBytes) {
      await reader.cancel();
      throw new Error('Catalog response too large');
    }
    chunks.push(Buffer.from(chunk.value));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
};

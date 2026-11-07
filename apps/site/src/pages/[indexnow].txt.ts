// IndexNow key file (https://www.indexnow.org/documentation): /<INDEXNOW_KEY>.txt holds the key,
// proving to Bing and the other IndexNow engines that we own the host. Not built without a key.
export function getStaticPaths() {
  const key = process.env.INDEXNOW_KEY;
  return key ? [{ params: { indexnow: key } }] : [];
}

export function GET() {
  return new Response(process.env.INDEXNOW_KEY);
}

let selectSession

export async function configureHttp(session, followsSystemProxy) {
  // Separate connection pools let in-flight queries finish on their selected route.
  const system = session.fromPartition('quotadesk-http', { cache: false })
  const direct = session.fromPartition('quotadesk-http-direct', { cache: false })
  await Promise.all([system.setProxy({ mode: 'system' }), direct.setProxy({ mode: 'direct' })])
  selectSession = () => followsSystemProxy() ? system : direct
}

export function fetchHttp(url, options) {
  if (!selectSession) return fetch(url, options)
  return selectSession().fetch(url, { ...options, credentials: 'omit' })
}

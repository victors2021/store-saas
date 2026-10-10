// The backend validates this development flag before passing it to Next. A
// local alias still goes through the existing database tenant/domain lookup.
export function isTenantHost(host: string | undefined | null, base: string | undefined, localAccess = false): boolean {
  if (!host || !base || !/^[a-z0-9.-]+(?::[0-9]{1,5})?$/.test(host)) return false
  const [domain, port] = host.split(":")
  if (port && (Number(port) < 1 || Number(port) > 65535)) return false
  const roots = [base]
  if (localAccess && /(^|\.)example\.test$/.test(base)) roots.push("shops.localhost")
  return roots.some(root => domain.endsWith(`.${root}`) &&
    /^[a-z][a-z0-9-]{1,46}[a-z0-9]$/.test(domain.slice(0, -(root.length + 1))))
}

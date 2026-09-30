// lego output is untrusted and may contain domains, challenge values or API
// responses. Return only fixed messages; never interpolate a matching line.
// ACME problem types follow RFC 8555 section 6.7. Propagation messages follow
// lego's documented DNS-01 output.
export const ACME_DIAGNOSTICS = Object.freeze({
  RATE_LIMITED: '证书机构限制了本次签发请求。请等待限制解除，避免频繁重复申请；可先在测试环境验证配置。',
  CAA_FORBIDDEN: '域名的 CAA 策略阻止证书机构签发。请检查域名及父域的 CAA 记录。',
  NXDOMAIN: 'ACME 验证查询返回 NXDOMAIN。请检查域名的公开 DNS 解析、权威 DNS 服务器及验证记录。',
  SERVFAIL: 'ACME 验证查询返回 SERVFAIL。请检查权威 DNS 服务器和域名委派是否正常。',
  PROPAGATION_TIMEOUT: 'DNS 验证记录在时限内未通过传播检查。请核对 TXT 记录、CNAME 委派与权威 DNS 可达性，稍后再试。',
  TXT_MISMATCH: '公开 DNS 返回的 TXT 记录与本次验证不符。请检查旧 TXT 记录、CNAME 委派和 DNS 传播。',
  ACCOUNT: 'ACME 账户信息或账户绑定未通过验证。请检查联系邮箱及证书机构账户要求。',
  UNAUTHORIZED: '证书机构未通过域名控制权验证。请检查当前验证方式及对外可见的挑战记录或站点。',
  VALIDATION_CONNECTION: '证书机构无法连接验证目标。请检查目标的 DNS 指向、端口与防火墙。',
  DNS_QUERY: '证书机构报告 DNS 查询失败。请检查域名的权威 DNS、验证记录及委派。',
  NETWORK: '申请时发生网络连接故障。请检查 NAS 出站网络、DNS 解析和代理，稍后再试。',
});

const ACME_ERROR = 'urn:ietf:params:acme:error:';

export function readAcmeDiagnostic(output) {
  if (typeof output !== 'string' || !output) return null;
  // Ignore earlier informational messages if lego supplied a final error
  // section. Both sources can be bounded by runProcess before reaching here.
  const text = output.slice(-131072);
  const markers = [...text.matchAll(/(?:Could not|Unable to) obtain certificates:/gi)];
  const failure = markers.length ? text.slice(markers.at(-1).index) : text;
  const problem = (name) => new RegExp(`${ACME_ERROR}${name}\\b`).test(failure);

  if (problem('rateLimited')) return ACME_DIAGNOSTICS.RATE_LIMITED;
  if (problem('caa')) return ACME_DIAGNOSTICS.CAA_FORBIDDEN;
  if (/\bNXDOMAIN\s+looking up\b|\bDNS problem:\s*NXDOMAIN\b/i.test(failure)) return ACME_DIAGNOSTICS.NXDOMAIN;
  if (/\bunexpected response code ['"]?SERVFAIL['"]?|\bDNS problem:\s*SERVFAIL\b/i.test(failure)) return ACME_DIAGNOSTICS.SERVFAIL;
  if (/\bpropagation:\s*time limit exceeded\b|\btime limit exceeded:\s*last error:/i.test(failure)) return ACME_DIAGNOSTICS.PROPAGATION_TIMEOUT;
  if (/\bdid not return the expected TXT record\b/i.test(failure)) return ACME_DIAGNOSTICS.TXT_MISMATCH;
  if (['accountDoesNotExist', 'externalAccountRequired', 'invalidContact'].some(problem)) return ACME_DIAGNOSTICS.ACCOUNT;
  if (problem('unauthorized')) return ACME_DIAGNOSTICS.UNAUTHORIZED;
  if (problem('connection')) return ACME_DIAGNOSTICS.VALIDATION_CONNECTION;
  if (problem('dns')) return ACME_DIAGNOSTICS.DNS_QUERY;
  if (/\bi\/o timeout\b|\bTLS handshake timeout\b|\bnetwork is unreachable\b|\bconnect: connection refused\b|\bno such host\b|\bcontext deadline exceeded\b/i.test(failure)) return ACME_DIAGNOSTICS.NETWORK;
  return null;
}

/** Transient release-host failures can use GitHub's asset API for the same pinned release and filename. */
export async function releaseResponse(url, options = {}) {
  const request = async (address, accept) => {
    const response = await fetch(address, { ...options, headers: { ...options.headers, accept } })
    if (!response.ok) {
      await response.body?.cancel()
      const error = new Error(`Release download: HTTP ${response.status}`)
      error.status = response.status
      throw error
    }
    return response
  }
  try {
    return await request(url, "application/octet-stream")
  } catch (error) {
    const source = new URL(url)
    const release = source.pathname.match(/^\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/)
    if (source.hostname !== "github.com" || !release || !transientDownloadError(error)) throw error
    const [, owner, repo, tag, filename] = release
    console.warn("Release host unavailable; trying GitHub's release-asset API")
    const metadata = await request(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`, "application/vnd.github+json")
    const body = await metadata.json()
    const asset = Array.isArray(body.assets) ? body.assets.find((each) => each?.name === decodeURIComponent(filename)) : undefined
    if (!Number.isSafeInteger(asset?.id) || asset.id <= 0) throw new Error("The pinned release has no matching asset")
    return request(`https://api.github.com/repos/${owner}/${repo}/releases/assets/${asset.id}`, "application/octet-stream")
  }
}

export function transientDownloadError(error) {
  const status = error.status ?? error.response?.status
  return status === 408 || status === 429 || status >= 500 && status < 600 ||
    error.name === "TimeoutError" || error.name === "AbortError" ||
    error instanceof TypeError && error.message === "fetch failed" ||
    ["ECONNRESET", "ETIMEDOUT", "UND_ERR_SOCKET"].includes(error.cause?.code)
}

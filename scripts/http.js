import axios from 'axios';

const UA = 'UltraScrape/1.0 (+https://github.com/justfinethanku/Ultra-Scrape; respectful, 1rps default)';

export function validateUrl(value, base) {
  try {
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('URL must start with http:// or https://');
    }
    return url.toString();
  } catch (err) {
    throw new Error(`Invalid URL: ${err.message}`);
  }
}

// Apply the same protocol, redirect and decompressed-body limits to every
// request, including feed/article/media URLs supplied by a remote page.
export async function fetchResource(url, { binary = false, referer } = {}) {
  return axios.get(validateUrl(url), {
    headers: { 'User-Agent': UA, ...(referer ? { Referer: referer } : {}) },
    timeout: 20000,
    maxRedirects: 5,
    maxContentLength: (binary ? 10 : 5) * 1024 * 1024,
    responseType: binary ? 'arraybuffer' : 'text',
    validateStatus: (status) => status >= 200 && status < 300
  });
}

import * as https from 'node:https';

const API_HOST = 'api.nordvpn.com';

interface NordCity { id: number; name: string }
interface NordCountry { id: number; name: string; code: string; cities?: NordCity[] }
interface NordMetadata { name: string; value: string }
interface NordTechnology { identifier: string; metadata?: NordMetadata[] }
interface NordServer {
  technologies?: NordTechnology[];
}

export interface ProxyLocation {
  type: 'country' | 'city';
  id: number;
  label: string;
  description: string;
}

export async function fetchLocations(): Promise<ProxyLocation[]> {
  const query = new URLSearchParams({
    'filters[servers_technologies][identifier]': 'proxy_ssl',
  });
  const countries = await getJson<NordCountry[]>(`/v1/servers/countries?${query}`);
  const locations: ProxyLocation[] = [];
  for (const country of countries.sort((a, b) => a.name.localeCompare(b.name))) {
    locations.push({
      type: 'country', id: country.id, label: country.name,
      description: `${country.code.toUpperCase()} · Fastest available server`,
    });
    for (const city of (country.cities ?? []).sort((a, b) => a.name.localeCompare(b.name))) {
      locations.push({
        type: 'city', id: city.id, label: `${city.name}, ${country.name}`,
        description: `${country.code.toUpperCase()} · City`,
      });
    }
  }
  return locations;
}

export async function recommendProxy(location: ProxyLocation): Promise<string> {
  const query = new URLSearchParams({
    'filters[servers_technologies][identifier]': 'proxy_ssl',
    'filters[servers_groups][identifier]': 'legacy_standard',
    [location.type === 'country' ? 'filters[country_id]' : 'filters[country_city_id]']: String(location.id),
    limit: '20',
  });
  const servers = await getJson<NordServer[]>(`/v1/servers/recommendations?${query}`);
  const server = servers[0];
  if (!server) throw new Error(`NordVPN returned no proxy server for ${location.label}`);
  const technology = server.technologies?.find(item => item.identifier === 'proxy_ssl');
  const proxyHostname = technology?.metadata?.find(item => item.name === 'proxy_hostname')?.value;
  if (!proxyHostname) throw new Error('NordVPN recommendation did not include a proxy hostname');
  return proxyHostname;
}

async function getJson<T>(path: string): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await directJsonRequest<T>(path);
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  throw new Error(`NordVPN API request failed: ${errorMessage(lastError)}`, { cause: lastError });
}

function directJsonRequest<T>(path: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = https.get({
      hostname: API_HOST,
      path,
      headers: { accept: 'application/json', 'user-agent': 'nord-proxy-vscode/0.0.2' },
      agent: new https.Agent({ keepAlive: false }),
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 5 * 1024 * 1024) request.destroy(new Error('NordVPN API response is too large'));
      });
      response.on('end', () => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`NordVPN API returned HTTP ${response.statusCode ?? 'unknown'}`));
          return;
        }
        try { resolve(JSON.parse(body) as T); }
        catch { reject(new Error('NordVPN API returned invalid JSON')); }
      });
    });
    request.setTimeout(15_000, () => request.destroy(new Error('NordVPN API request timed out')));
    request.once('error', reject);
  });
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as NodeJS.ErrnoException).code;
  return code ? `${error.message} (${code})` : error.message;
}

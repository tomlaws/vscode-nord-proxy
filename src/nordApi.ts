const API_HOST = 'api.nordvpn.com';

interface NordCity { id: number; name: string }
interface NordCountry { id: number; name: string; code: string; cities?: NordCity[] }
interface NordMetadata { name: string; value: string }
interface NordTechnology { identifier: string; metadata?: NordMetadata[] }
interface NordServer {
  id: number;
  name: string;
  hostname: string;
  load: number;
  technologies?: NordTechnology[];
}

export interface ProxyLocation {
  type: 'country' | 'city';
  id: number;
  label: string;
  description: string;
}

export interface RecommendedProxy {
  id: number;
  name: string;
  hostname: string;
  load: number;
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

export async function recommendProxy(location: ProxyLocation): Promise<RecommendedProxy> {
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
  return { id: server.id, name: server.name, hostname: proxyHostname, load: server.load };
}

async function getJson<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`https://${API_HOST}${path}`, {
      headers: { accept: 'application/json', 'user-agent': 'nord-proxy-vscode/0.0.1' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`NordVPN API returned HTTP ${response.status}`);
    try { return await response.json() as T; }
    catch { throw new Error('NordVPN API returned invalid JSON'); }
  } catch (error) {
    if (controller.signal.aborted) throw new Error('NordVPN API request timed out');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

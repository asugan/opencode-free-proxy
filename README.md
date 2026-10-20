# OpenCode → CLIProxyAPI proxy

Node.js + TypeScript. OpenAI Chat Completions isteklerini OpenCode'a ileten küçük aracı sunucu. Runtime bağımlılığı yok; Node HTTP, fetch ve stream kullanır.

## 403 düzeltmesi ve canlı doğrulama

Sıradan Chat Completions isteği ve yalnızca header taklidi `403 FreeTierError` döndürüyordu. Kurulu OpenCode **2.0.32** istemcisinin isteği izole ortamda incelendi. Aşağıdaki kombinasyonla `big-pickle` modelinden **HTTP 200 / OK** alındı ve proxy'ye uygulandı:

- `Authorization: Bearer public` — kişisel OpenCode anahtarı gerekmiyor; `.env` içindeki `OPENCODE_API_KEY` boş kalabilir.
- `User-Agent: opencode/latest/2.0.32/cli` ve OpenCode oturum header'ları.
- `ses_` + 12 hex + 14 Base62 karakter biçiminde oturum ID'si.
- Upstream'e her zaman `stream: true`.
- `bash`, `glob`, `grep`, `read` araç tanımları; istemcide eksik olanlar yalnızca uyumluluk tanımı olarak eklenir.

**Derlenmiş proxy üzerinden canlı doğrulandı:** normal JSON yanıtı, SSE akışı ve istemcinin tanımladığı `lookup` aracına çağrı. Üçü de `big-pickle` ile **200** döndürdü. Diğer listedeki modellerin tamamı canlı denenmedi.

Önemli düzeltme: önceki gerçek istemci denemesinde tüm araç izinleri kapatılmıştı; bu yüzden o 403 sonucu, normal OpenCode isteğinin de başarısız olduğunu kanıtlamıyordu. Araç tanımlarının ve streaming'in de hesaba katılmasıyla çalışan istek elde edildi.

Bu, sağlayıcının erişim kurallarının gelecekte değişmeyeceği anlamına gelmez. Güncel kullanım koşullarına uy; hesap/kota/IP döndürme veya otomatik yeniden deneme yapılmaz. Kalan 403/429 hataları aynen iletilir.

## Kurulum

Node.js **22.19+** gerekir.

```bash
cd /home/asugan/Projects/opencode-free-proxy
npm install
```

Bu klasörde ilk kurulumda rastgele `PROXY_API_KEY` içeren `.env` oluşturuldu. Yoksa:

```bash
cp .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Üretilen anahtarı `.env` içindeki `PROXY_API_KEY` değerine yaz. `OPENCODE_API_KEY` boşsa upstream için `public` kullanılır. Kendi OpenCode anahtarını isteğe bağlı verebilirsin. Bu iki anahtar farklıdır: ilki CLIProxyAPI → proxy, ikincisi proxy → OpenCode içindir. `.env` ve gerçek anahtarları Git'e ekleme.

```bash
npm run dev
# Derlenmiş sürüm:
npm run build
npm start
```

Varsayılan adres: `http://127.0.0.1:8787`. Servis otomatik kurulmaz; terminal kapatılırsa kapanır.

## CLIProxyAPI bağlantısı

```text
İstemci → CLIProxyAPI :8317 → bu proxy :8787 → OpenCode
```

CLIProxyAPI sürümüne göre mevcut config'e ilgili örneği **birleştir**:

- v8: [`examples/cliproxyapi.v8.yaml`](examples/cliproxyapi.v8.yaml), `api-keys.openai-compatibility` altında.
- Eski sürüm: [`examples/cliproxyapi.legacy.yaml`](examples/cliproxyapi.legacy.yaml), kökte `openai-compatibility` altında.

`PASTE_PROXY_API_KEY_FROM_ENV` yerine `.env` içindeki `PROXY_API_KEY` değerini koy. Mevcut config'i silme, aynı YAML anahtarını ikinci kez tanımlama. CLIProxyAPI'yi config'ine uygun şekilde yeniden yükle/başlat.

Örnek model: `opencode-big-pickle`. CLIProxyAPI bunu upstream `big-pickle` adına çevirir. CLIProxyAPI'ye bağlanan istemci ise CLIProxyAPI'nin kendi istemci anahtarını kullanır; proxy anahtarını değil.

### Docker / farklı makine

`127.0.0.1` yalnızca aynı ağ ad alanını gösterir. CLIProxyAPI Docker içindeyse host'taki proxy'ye ulaşmak için `host.docker.internal` ve Linux'ta `host-gateway` eşlemesi veya uygun host networking gerekir. Proxy'nin `HOST` değerini erişilebilir arayüze ayarlaman gerekebilir. `HOST=0.0.0.0` tüm arayüzleri açar; güvenlik duvarıyla erişimi sınırla. Genel internet için TLS reverse proxy ve rate limit gerekir; bu proje bunları kurmaz.

## Kontrol

Anahtarı shell geçmişine yazmadan, proje klasöründe:

```bash
curl http://127.0.0.1:8787/health

node --env-file=.env --input-type=module <<'JS'
const headers = {
  authorization: `Bearer ${process.env.PROXY_API_KEY}`,
  'content-type': 'application/json',
};
console.log(await (await fetch('http://127.0.0.1:8787/v1/models', { headers })).json());
const response = await fetch('http://127.0.0.1:8787/v1/chat/completions', {
  method: 'POST', headers,
  body: JSON.stringify({
    model: 'big-pickle',
    messages: [{ role: 'user', content: 'Yalnızca merhaba yaz.' }],
    stream: true,
    max_tokens: 32,
  }),
});
console.log('HTTP', response.status);
for await (const chunk of response.body) process.stdout.write(chunk);
JS
```

`/health` yalnızca proxy'nin çalıştığını gösterir. `/v1/models` **yerel yapılandırılmış listeyi** döndürür; upstream erişimi veya anlık model kullanılabilirliğini doğrulamaz. `403 FreeTierError` ağ/proxy hatası değil, OpenCode erişim kısıtıdır. `429` kota/rate limit durumudur; `Retry-After` korunur. Otomatik retry yok.

## Kapsam

- `GET /health` — anahtarsız liveness.
- `GET /v1/models` — Bearer anahtarlı, yerel allowlist.
- `POST /v1/chat/completions` — istemci `stream:true` isterse SSE, aksi halde upstream SSE akışı birleştirilerek normal OpenAI JSON yanıtı döner. Metin, reasoning, çoklu choice, tool_calls, finish_reason ve usage korunur.
- İstemcinin araç şemaları ve açıkça verdiği `tool_choice` korunur. Eksik dört uyumluluk tanımı eklenir. Araçsız sohbette varsayılan `tool_choice:none` olur.
- Proxy **hiçbir araç çalıştırmaz**, shell açmaz, dosya okumaz. İstemcinin tanımlamadığı araca çağrı gelirse yanıt hata ile kesilir; bu çağrı istemciye aktarılmaz. Güvenlik için tool-call parçaları tamamlanana kadar tutulur; metin anında akar.
- `x-opencode-session`, `x-session-id`, `x-opencode-session-id` veya gövdedeki `prompt_cache_key` varsa oturum eşlemesinde kullanılır. Canonical oturum aynen korunur; diğer değerler deterministik eşlenir. Hiçbiri yoksa yeni ID üretilir.
- İstemci bağlantısı kapanınca upstream iptal edilir; backpressure korunur. Yerel anahtar upstream'e iletilmez. Prompt/anahtar loglanmaz.
- 4 MiB istek, 1 MiB SSE event, 32 MiB toplam upstream yanıt sınırı; varsayılan **300 saniye toplam istek/akış süresi**. Eksik `[DONE]`, eksik finish_reason ve uyumluluk aracına çağrı normal JSON isteğinde 502; SSE başladıysa bağlantı kesilmesi olarak görünür.
- `/responses`, `/messages`, embeddings, görsel üretimi, ses çıktısı ve tarayıcı CORS desteği yok. Eski `functions/function_call` yerine `tools/tool_choice` kullan. Gerekli istemci protokol dönüşümlerini CLIProxyAPI üstlenmeli.

## Modeller / ücret riski

`src/proxy.ts` içinde dokümantasyon ve canlı model listesine göre hazırlanmış 9 chat modeli var. System One kullanan `jev-1.13-free`, Chat Completions modeli olmadığı için dahil değil. Liste otomatik güncellenmez.

`.env` üzerinden listeyi değiştirebilirsin:

```dotenv
ALLOWED_MODELS=big-pickle,glm-5.3-flash-free
REQUEST_TIMEOUT_MS=300000
```

Bu ayar varsayılan listenin **tamamını değiştirir**. CLIProxyAPI örneğindeki modelleri de aynı şekilde düzenle. Allowlist dışı modeller upstream'e gitmeden reddedilir.

**Allowlist fiyat kontrol sistemi değildir. Ücretsiz dönem bitebilir, model erişimi kaldırılabilir. Bir modele izin vermeden önce güncel fiyatı kontrol et; OpenCode hesabında harcama sınırı ve otomatik bakiye yükleme ayarlarını gözden geçir.** Bazı ücretsiz modellerde veri saklama/eğitim koşulları farklıdır; hassas veri gönderme.

Upstream adresi `OPENCODE_BASE_URL` ile değiştirilebilir; `/chat/completions` sonuna eklenir. Anahtarların/promptların başka sunucuya gitmemesi için bu ayarı yalnızca güvendiğin endpoint'e yönelt. Redirect takip edilmez. Uzak upstream için HTTPS zorunludur.

## Test

```bash
npm run check
npm test
npm run build
```

Testler yerel sahte upstream kullanır; dış servise istek veya ücret oluşturmaz. Auth, allowlist, JSON doğrulama, istek boyutu, canonical oturumlar, uyumluluk araçları, parçalı UTF-8/CRLF SSE, reasoning/usage birleştirme, tool-call güvenliği, eksik akışlar, bağlantı iptali, timeout ve upstream hata aktarımı doğrulanır.

## Kaynaklar

- [OpenCode modeller / endpoint / fiyat / gizlilik](https://opencode.ai/docs/zen/)
- [Canlı model listesi](https://opencode.ai/inference/v1/models)
- [CLIProxyAPI resmi örnek config](https://github.com/router-for-me/CLIProxyAPI/blob/main/config.example.yaml)
- [OpenCode oturum ID üretimi](https://github.com/anomalyco/opencode/blob/dev/packages/schema/src/identifier.ts)
- [FreeTierError / header, oturum, araç ve streaming bulguları](https://github.com/decolua/9router/issues/4101)
- [Resmî istemcide aynı hata ve araç izinleri](https://github.com/anomalyco/opencode/issues/49680)
# opencode-free-proxy

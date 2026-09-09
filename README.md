# Usage Notch

Windows görev çubuğunda duran, yapay zekâ kodlama araçlarının kullanım
limitlerini gösteren küçük bir tepsi uygulaması. Simgenin üzerine gelince
panel açılır.

## Neden bu uygulama sayı uydurmuyor

En sık yapılan tasarım hatası şudur: yerel günlüklerden token'ları topla, bir
limite böl, yüzde göster. **Bu yaklaşım çalışmaz** ve bu proje onu bilerek
reddetti:

1. **Payda yok.** Anthropic Pro/Max için sayısal bir token limiti yayınlamıyor.
   Üstelik 26 Mart 2026'dan beri 5 saatlik limitler günün saatine göre
   ağırlıklı — aynı token yoğun saatlerde kotadan daha fazla yiyor. Tek bir
   sabit payda günün bir kısmında matematiksel olarak yanlıştır.
2. **Yerel dosyalar kör.** Kotan claude.ai, Cowork ve diğer cihazlarınla
   paylaşımlı. Anthropic kendi yerel hesaplamasını bile "yaklaşık" diye
   etiketliyor. Hatanın yönü hep **iyimser** — yani "%40 kaldı" deyip seni uzun
   bir iş ortasında kestirir. Bu, uygulamayı hiç olmamasından kötü yapar.
3. **Token sınıflarını toplamak anlamsız.** Bu makinede ölçüldü: `cache_read`
   tüm hacmin %97,94'ü, `input` ise %0,01. Dördünü toplayınca çıkan sayı
   tamamen 0,1x ücretlendirilen önbellek okumalarından ibaret oluyor.

Bunun yerine yüzde, aracın kendi statusline betiğine verdiği **sunucuda
hesaplanmış** veriden gelir: Claude Code'da `rate_limits`, Antigravity CLI'da
`quota`. Yerel günlükler yalnızca mutlak token sayısı, model dağılımı ve yakım
hızı için kullanılır — asla bir yüzdeye dönüştürülmez.

Antigravity `quota` alanında **kalan** oranı verir (`remaining_fraction`), bu
uygulama ise **kullanılan** oranı gösterir. Çevrim tek bir yerde yapılır
(`src/core/ratelimits.js`); köprünün yazdığı dosyada sayı, CLI'ın söylediği
haliyle durur.

Bağlanmadıysan panel **çubuk ve yüzde göstermez**; sadece mutlak sayıları
gösterir. Bilinmeyen paydayla çizilmiş dolu bir ilerleme çubuğu yalandır.

## Kurulum

```bash
npm install
npm start
```

Görev çubuğunda simge belirir. Üzerine gelince panel açılır, tıklayınca sabitlenir.

### Claude'u bağlamak

Panelde Claude satırındaki **Bağla** düğmesi, Claude Code ayarlarına
(`~/.claude/settings.json`) bir statusline köprüsü kurar. Köprü yalnızca yüzde
ve sıfırlanma zamanını bir dosyaya yazar; **hiçbir sohbet içeriği, dosya yolu
veya kimlik bilgisi yazmaz.**

Zaten bir `statusLine` ayarın varsa uygulama **üzerine yazmaz** — sana durumu
bildirir ve elle zincirlemeni ister. Yazmadan önce zaman damgalı yedek alır.

### Antigravity

Antigravity'nin iki ayrı kaynağı var ve ikisi **farklı pencereyi** doldurur.

| Pencere | Kaynak | Güven |
| --- | --- | --- |
| 5 saatlik | Antigravity IDE'nin `state.vscdb` durum deposu | `derived` — belgelenmemiş biçim |
| Haftalık | `agy` CLI statusline kancası | `documented` — belgelenmiş JSON alanı |

Bu ayrım satırda taşınır (`provenance`): ikisi de sunucuda hesaplanmış gerçek
sayılardır, ama biri yayınlanmış bir arayüzden, diğeri iç bir biçimden gelir.
Aynı görünümde sunulup aynı güveni iddia etmeleri doğru olmazdı.

#### 5 saatlik limit: IDE durum deposu

**Bunun için hiçbir şey kurmanız gerekmiyor.** Antigravity IDE zaten
kuruluysa satır beş saatlik yüzdeyi kendiliğinden gösterir.

Bu, bu projedeki **tek belgelenmemiş arayüz**. Daha önce bu dosyayı okumayı
reddediyorduk; kullanıcı bu kararı, aşağıdaki üç koruma şart koşularak
**bilerek tersine çevirdi**. Reddi sessizce silmek yerine niçin değiştiğini
yazıyoruz — çünkü korumalar kararın kendisi kadar önemli.

Gerekçe: ürün kurulum klasörünü `Antigravity`'den `Antigravity IDE`'ye
yeniden adlandırdı. Sabit yazılmış bir yol terk edilmiş klasörü okumaya devam
etti ve **112 günlük veriyi güncelmiş gibi** döndürdü. Kendinden emin yanlış
bir sayı, bu projenin var oluş sebebi olan tek hatadır.

1. **Kurulum klasörü asla sabit yazılmaz.** `%APPDATA%` altında adı
   `Antigravity` ile başlayan tüm klasörler taranır, `state.vscdb` içerenler
   aday olur ve **en son yazılan** seçilir. Bir sonraki yeniden adlandırma kod
   değişikliği gerektirmez. Hangi adayın seçildiği günlüğe yazılır.
2. **Bayat depo asla yüzde üretmez.** Dosyanın kendi `mtime`'ı yakalama anıdır
   ve statusline köprüleriyle **aynı** tazelik kuralından geçer. 112 günlük
   depo sözle ifade edilen bir yokluğa dönüşür; hiçbir koşulda sayıya değil.
3. **Çözümleme katıdır ve kapalı düşer.** Belgelenmiş bir JSON alanı yeniden
   adlandırılınca okuma `undefined` verir — kapalı düşer. Alan numaralı bir
   protobuf ise **açık düşer**: başka bir değer o numaraya oturur, `[0,1]`
   aralığındadır ve elimizdeki tüm korumaları geçer. Bu yüzden beklenen şekil
   (alan numaraları ve wire tipleri) tam olarak doğrulanır; en ufak sapmada
   **okumanın tamamı reddedilir** ve günlüğe düşer.

   **Bunun yakalayamadığı şey**, dürüstçe: anlamsal bir tersine dönme. Alan 15.1
   `[0,1]` aralığında bir float kalıp anlamı "kalan"dan "kullanılan"a dönerse
   0,4 sessizce 0,6 olur — iyimser yönde, yani en kötü yönde. Yapısal hiçbir
   kontrol bunu göremez. Bu artık risk kabul edildi ve figürün `derived` olarak
   işaretlenmesinin sebebi tam olarak budur.

Okunan **tek anahtar** `antigravityUnifiedStateSync.userStatus`, veritabanı
**salt okunur** açılır. Aynı tabloda duran `antigravityUnifiedStateSync.oauthToken`
hiç adlandırılmaz, seçilmez, listelenmez; kodda `SELECT *` yoktur.

Model başına kotalar, **aynı (oran, sıfırlanma) çiftleri tekilleştirilerek**
gruplanır. Bu, modeller arasında bir ilişki iddia etmez — sadece iki sayının
aynı iki sayı olduğunu söyler. Grup başlığı yüzdeyi taşır, üyeler **yalnızca
ad** taşır: böylece "Claude Opus 4.6 · %60" gibi bir metin **yapısal olarak
üretilemez**. Bu önemli, çünkü öyle bir metin kullanıcının gerçek Claude Code
satırının hemen altında durur ve Claude'un kotası hakkında bir iddia gibi
okunur.

**Haftalık limit bu depoda yok.** Her model tam olarak bir kota girdisi
taşıyor; ikinci bir ufuk hiçbir yerde geçmiyor. Antigravity'nin kendi arayüzü
haftalık limiti gösterdiğine göre onu canlı çekiyor ve saklamıyor. Bu yüzden
haftalık pencere `bildirilmiyor` der — `bilinmiyor` değil. İkisi farklı
iddialar: kullanıcı haftalık limitin var olduğunu kendi ekranında görebiliyor,
dolayısıyla "yok" demek yanlış olurdu.

#### Haftalık limit: `agy` CLI kancası

Aynı mekanizma, Antigravity'nin belgelenmiş
[`agy` statusline kancası](https://antigravity.google/docs/cli/statusline/)
üzerinden: **Bağla** düğmesi `~/.gemini/antigravity-cli/settings.json`
dosyasındaki `statusLine` anahtarını kurar. CLI ajan durumu her değiştiğinde
köprüyü çalıştırır ve durum JSON'unu betiğin `stdin`'ine borular; köprü o
JSON'dan **yalnızca** `quota` içindeki sayısal alanları alır. Aynı JSON'da
`cwd`, `transcript_path`, `email`, `vcs.branch` ve model adı da gelir; bu
alanların **değerleri hiç okunmaz ve hiçbir yere yazılmaz**. Yazılan tek şey,
teşhis için tutulan **en üst düzey anahtar adları** listesidir (`payloadKeys`)
— yani `email` kelimesi dosyada geçer, e-posta adresi geçmez. Bunu
`test/antigravity.test.js` içindeki "persists no chat content, path, branch,
e-mail or identifier" testi sabitliyor. Ayar dosyasında yalnızca `statusLine`
anahtarına dokunulur; `~/.gemini` altındaki kimlik bilgilerine hiç bakılmaz.

Bu makinede `agy` kurulu değilse düğme bunu **açıkça söyler ve hiçbir dosya
oluşturmaz** — var olmayan bir programın ayar dosyasını yazmak, kimsenin
okumayacağı bir çöp bırakmak olurdu. Bu bir arıza değil: beş saatlik limit
`agy` olmadan da görünür, CLI yalnızca haftalık pencere için gerekir. Var olan bir `statusLine` yine üzerine
yazılmaz; zincirleme komutu sana verilir. (`agy`, `stack_with_default: true`
seçeneğiyle kendi satırını yerleşik satırın altına eklemeye de izin veriyor.)

Antigravity kotasını **kova adıyla** eşleştiriyoruz: adında `week` geçen kova
haftalık pencereye yazılır. Adını tanımadığımız bir kova gösterilmez —
yanlış etiketlenmiş bir sayı, eksik bir sayıdan kötüdür. Kova adları
belgelenmediği için bu, bu sağlayıcının en olası arıza noktası: hiçbir kova
tanınmadıysa uygulama günlüğüne `antigravity quota unusable: reason=...
ids=...` satırı düşer, böylece hangi adı tanımadığımız hata bildiriminde
görünür.

Antigravity satırında mutlak token, yakım hızı ve haftalık maliyet **yoktur**:
bu makinede o aracın transkriptleri okunmuyor ve komşu satırın sayılarını ödünç
almak yanlış aracı anlatmak olur.

**Açık soru, tahmin edilmiyor:** CLI'ın haftalık kovası ile IDE'nin beş saatlik
figürü aynı havuzu mu ölçüyor, bilmiyoruz. Ufukları farklı — bu yüzden ayrı
pencerelerde duruyorlar ve asla tek bir sayının iki görünümü gibi
sunulmuyorlar — ama "farklı ufuk", "farklı havuz" demek değil. Kesin cevap için
`agy` CLI'ın IDE ile aynı makinede kurulu olması gerekiyor; buradaki hiçbir
makinede öyle değil. Cevap gelene kadar ikisi de oldukları şey olarak
gösteriliyor: ayrı kaynaklı iki pencere, her biri geldiği alanla etiketli.

## Güvenlik duruşu

- **Sıfır giden ağ trafiği.** Bağımlılık ağacında HTTP istemcisi yok. Telemetri,
  çökme raporu ve güncelleme kontrolü yok. Doğrulaması: uygulamanın exe'sine
  giden bağlantıyı engelleyen bir güvenlik duvarı kuralı ekle — hiçbir sayı
  kaybolmamalı.
- **OAuth token'ına dokunulmuyor.** `~/.claude/.credentials.json` hiç açılmıyor.
  Aynı kural `~/.gemini` için de geçerli: adı geçen tek dosya
  `antigravity-cli/settings.json`, okunan/yazılan tek anahtar `statusLine`.
  Antigravity IDE'nin `state.vscdb` deposu **salt okunur** açılır ve tek bir
  anahtar adıyla sorgulanır; aynı tablodaki `...oauthToken` hiç adlandırılmaz.
  Kodda `SELECT *` bulunmuyor ve bu bir testle sabitlenmiş durumda.
- **`node:sqlite` bir bağımlılık değil.** Electron 44'ün getirdiği Node'un
  içinde geliyor; kimsenin taşıdığı yerel bir modül eklenmedi. Yüklerken
  bastırdığımız tek şey kendi `ExperimentalWarning`'i — diğer tüm uyarılar
  görünmeye devam ediyor.
- **Transkript disiplini.** Her satırdan yalnızca `timestamp`, `model` ve dört
  sayısal token alanı okunur. Sohbet metni, `cwd`, `gitBranch` hiç okunmaz.
  Ayrıştırma hatasında satırın kendisi ve `JSON.parse` hata mesajı loglanmaz —
  ikisi de kaynak metni sızdırabilir.
- **Kalıcı depoda yol yok.** İmleç anahtarları SHA-256 özeti.
- Renderer `contextIsolation:true`, `nodeIntegration:false`, `sandbox:true` ve
  katı CSP ile çalışır. Dosyadan gelen hiçbir metin `innerHTML`'e verilmez.

## Geliştirme

```bash
npm test     # tip kontrolü + 667 test
npm run scan # gerçek corpus üzerinde tarama ölçümü
npm run build # paketleme derlemesi (dist/ temizlenip yeniden üretilir)
npm run smoke # Electron IPC duman testi

node src/renderer/dev/serve.mjs # panel önizlemesi (yalnızca geliştirme)
```

`npm start` derlemeyi `prestart` ile kendisi yapar; ayrıca bir adım gerekmez.

`src/renderer/dev/` paketlenen uygulamaya dahil **edilmez** — içindeki önizleme
sunucusu dinleyen bir soket açar ve yayınlanan uygulamada böyle bir şey yoktur.

## Mimari

- `src/core/**` — toplayıcı, ayrıştırıcı, birleştirici. Electron'dan tamamen
  bağımsız; ileride başka bir kabuğa taşınabilsin diye.
- `src/main/**` — Electron ana süreci, tepsi, panel penceresi, köprü kurulumu.
- `src/renderer/**` — panel arayüzü. Sıfır çalışma-zamanı bağımlılığı.
- `src/shared/contract.ts` — iki taraf arasındaki sözleşme. Renderer kullanım
  verisi üzerinde **hiç aritmetik yapmaz**; ana süreç çözülmüş değerler gönderir.
- `src/core/antigravity/**` — IDE durum deposu okuyucusu: kurulum çözümleme
  (koruma 1), katı protobuf çözücü (koruma 3a) ve `node:sqlite` sarmalayıcısı.
- `bridge/claude-statusline.mjs`, `bridge/antigravity-statusline.mjs` —
  statusline köprüleri. Aynı disiplin: stdin'den oku, yalnızca sayısal kota
  alanlarını küçük bir dosyaya yaz, başka hiçbir şeyi kaydetme, ağ açma.

Kararların gerekçesi: `ADR-001` (orkestratör karar kaydı).

## Bu sürümde ne var, ne yok

**Var:** Claude Code canlı (gerçek yüzde + mutlak token), Antigravity canlı
(IDE deposundan beş saatlik yüzde + model kırılımı; `agy` kuruluysa haftalık
yüzde; token/maliyet yok), açılışta başlatma, tepsi simgesi,
hover paneli, altı sağlayıcı satırı, Bağla/Ekle düğmeleri.

**Yok:** Codex, Kimi, Copilot, Gemini için canlı veri. Bunların her biri farklı
bir mekanizma gerektiriyor (Codex bir JSON-RPC el sıkışması ve SQLite; Gemini
hiç yüzde vermiyor) — "yerel dosya oku" ortak bir soyutlama değil. Satırlar
pasif duruyor ve hiçbiri uydurma sayı göstermiyor.

**Antigravity'de eksik olan:** `agy` CLI kurulu değilse haftalık pencere.
IDE'nin durum deposu haftalık figürü saklamıyor, biz de uydurmuyoruz; o satır
`bildirilmiyor` diyor.

Bu paragraf daha önce "IDE'nin `state.vscdb`'sini okumuyoruz, çünkü
belgelenmiş bir arayüz değil" diyordu. O karar, yukarıdaki üç koruma şart
koşularak kullanıcı tarafından tersine çevrildi. Metni silmek yerine
değiştirdik: reddin niçin kaldırıldığı, reddin kendisi kadar kayda değer.

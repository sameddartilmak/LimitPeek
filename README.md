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

Görev çubuğunda simge belirir. Simgeye tıklayınca panel açılır; paneldeki
raptiye düğmesi onu sabitler.

Panel **odağı almadan** açılır (`showInactive`). Yazmakta olduğunuz pencere
odağını korur; panele tıkladığınızda odağı Windows'un kendisi verir. Sebebi:
odak alındığında kabuğun odak devrini panelin yaşam döngüsüne sokuyorduk ve
bu, kazanılamayacak bir yarıştı — gerçek tıklamalarda ölçülen devir süreleri
414 ms ile 1355 ms arasında dağılıyordu, dolayısıyla "N ms boyunca odak
kaybını yok say" biçimindeki her sabit eşik arkasında bir kuyruk bırakıyor ve
panel kullanıcının eli daha simgedeyken kapanıyordu.

Kapanma kuralı artık tamamen **imleç** üzerinden: panele hiç girilmediyse
imleç, simge ile panel arasındaki koridordan çıkınca kapanır; panele
girildiyse ayrıldıktan kısa süre sonra kapanır; sabitlenmişse yalnızca açık
bir kapatma ya da raptiyeyi kaldırma kapatır. Hiç etkileşilmemiş bir panel
için son çare olarak bir dakikalık üst sınır var — imleç hiç kımıldamadan
klavyeye dönülen durum için.

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

**Seçili model.** Antigravity'de o an hangi modeli seçtiyseniz, satır onu
işaretler. `antigravityUnifiedStateSync.modelPreferences` anahtarı — kota ile
tamamen aynı çift-base64 zarfını kullanıyor — seçili model kimliğini taşıyor
(canlı doğrulandı: `EIII` → `10 82 08` → 1026 → "Claude Opus 4.6 (Thinking)").
Kimlik, model listesindeki kimliklerle eşleştiriliyor; **tam olarak bir**
modele karşılık gelmiyorsa seçim gösterilmez. Sözleşmedeki alanlar:
`ModelQuotaDetail.selectedModel` (ad) ve `selectedGroupIndex` (hangi grupta).

Seçim çözümlemesi **yalnızca seçimi** reddeder: tercih anahtarı beklenmedik
bir şekle bürünürse ya da model kimlikleri okunamazsa yüzdeler etkilenmez.
Yanlış modeli işaretlemek, yanındaki sayı hakkında yanlış bir iddiadır; "hangi
model olduğunu bilmiyoruz" ise değildir.

**IDE kapalıyken.** Depoyu yazan program kapalıysa yeni sayı gelmez, ama son
bilinen sayı kendi penceresi hâlâ açıkken **doğru bir ifadedir**. O yüzden
gösterilir: satır `stale` işaretlenir ve `capturedAt` ile birlikte gelir
("… önce güncellendi"). Pencerenin sıfırlanma anı geçtiğinde sayı eski değil
**yanlış** olur; o noktada `rolled-over` denir ve sayı düşürülür. Terk edilmiş
bir kurulumun asla güncel sanılmaması için ayrıca **bir haftalık sert üst
sınır** var: bunun ötesinde hiçbir şey gösterilmez.

**Yenile'ye basıldığında.** Okuma eskiyse ve Antigravity IDE süreci
çalışmıyorsa, yenileme yanıtı `refreshNotices: ['ANTIGRAVITY_NOT_RUNNING']`
taşır; arayüz bunu "Antigravity açık değil…" baloncuğuna çevirir. Süreç
listesi `tasklist.exe` ile mutlak yoldan okunur (ağ yok, kabuk yok); okunamazsa
cevap `unknown` olur ve **hiçbir şey söylenmez** — editörünüz açıkken "kapalı"
demek yanlış bir ifade olurdu. Sonda yalnızca okuma zaten eskiyken çalışır, ki
gereksiz yere yarım saniye harcanmasın.

**Anında güncelleme.** Toplayıcı, seçilen kurulumun `state.vscdb` klasörünü
izliyor; model değiştirdiğinizde 15 saniyelik taramayı beklemeden (400 ms
gecikmeyle) satır yeniden kuruluyor.

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

Bu makinede `agy` kurulu değilse **Bağla** düğmesi onu tek tıkla kurabilir: onayınızı isteyen bir pencere çıkar (“Antigravity CLI'ı antigravity.google adresinden indirip kuracak”), onaylarsanız uygulama aracı indirip kurar ve ardından zaten bildiği durum-satırı köprüsünü yapılandırır. Bu, uygulamanın **tek** ağ erişimidir ve yalnızca burada, sizin onayınızla olur — çalışma anındaki sıfır-ağ sözü bozulmaz (aşağıya bakın). İndirme başarısız olursa hiçbir şey değişmez ve bu söylenir.

Önemli, dürüstçe: `agy`, IDE'den **ayrı** kimlik doğrular (kendi anahtarlığı/tarayıcı oturumu). Kurulumdan sonra kotanın görünmesi için `agy`'ı bir kez çalıştırıp oturum açmanız gerekir; oturum durumunu okuyamıyoruz çünkü bu bir kimlik-bilgisi okuması olurdu ve uygulama bunu asla yapmaz. Bu yüzden akış oturumu **doğrulamaz**, yönlendirir.

Geri dönüşü var: köprü yapılandırıldıysa “bağlantıyı kaldır” yalnızca **bizim** yazdığımız `statusLine` kancasını (yedek alarak) siler; `agy` aracı yerinde kalır. Var olan yabancı bir `statusLine` üzerine yazılmaz.

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

- **Çalışma anında sıfır giden ağ trafiği.** Bağımlılık ağacında HTTP istemcisi yok.
  Telemetri, çökme raporu ve güncelleme kontrolü yok. Snapshot, yenileme, tarama — hiçbiri
  ağa çıkmaz. Doğrulaması: uygulamanın exe'sine giden bağlantıyı engelleyen bir güvenlik
  duvarı kuralı ekle — hiçbir sayı kaybolmamalı.
- **Tek istisna, açıkça sınırlanmış: isteğe bağlı `agy` kurulumu.** Antigravity satırında
  **Bağla**'ya bastığınızda, `agy` kurulu değilse uygulama onu antigravity.google'dan
  indirir. Bu, bir defalık, onaya bağlı bir **kurulum adımı**dır — çalışma-anı çağrısı
  değil. Kodda tek, dar, yorumlu bir yerde olur (`src/core/antigravity/cli-install.js`),
  onay penceresi tam üstünde durur; indirdiği şey vendor'ın belgelediği PowerShell
  komutudur (`irm https://antigravity.google/cli/install.ps1 | iex`), mutlak yoldan,
  kabuk olmadan, zaman aşımlı. Zamanlayıcıyla ya da sizden habersiz asla çalışmaz.
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
npm test     # tip kontrolü + 795 test
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
  (koruma 1), katı protobuf çözücü (koruma 3a), `node:sqlite` sarmalayıcısı ve
  süreç sondası (`process.js`) ve tek-tık `agy` kurulumu (`cli-install.js` — uygulamanın tek ağ erişiminin yaşadığı dar, onay kapılı yer).
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

**Haftalık limit neden yok:** Depodaki 130 anahtarın tamamı tarandı, her
base64 protobuf değeri çözüldü: tek bir kota yapısı var ve hiçbir yerde
"week"/"weekly" geçmiyor. Bilinen tek kaynak, Antigravity'nin yerel dil
sunucusuyla loopback RPC — ki bu, başka bir sürecin komut satırından CSRF
belirteci okumayı gerektiriyor ve uygulamanın "kimlik bilgisi okumaz"
duruşuyla çelişiyor. Bu yüzden **yapılmadı**; haftalık pencere
`bildirilmiyor` demeye devam ediyor.

**Antigravity'de eksik olan:** `agy` CLI kurulu **ve oturum açılmış** değilse haftalık
pencere. Kurulumu tek tıkla yapabilirsiniz (yukarı); ama `agy` kendi oturumunu ister ve
kotayı ancak siz onu bir kez çalıştırıp giriş yaptıktan sonra yayar.
IDE'nin durum deposu haftalık figürü saklamıyor, biz de uydurmuyoruz; o satır
`bildirilmiyor` diyor.

Bu paragraf daha önce "IDE'nin `state.vscdb`'sini okumuyoruz, çünkü
belgelenmiş bir arayüz değil" diyordu. O karar, yukarıdaki üç koruma şart
koşularak kullanıcı tarafından tersine çevrildi. Metni silmek yerine
değiştirdik: reddin niçin kaldırıldığı, reddin kendisi kadar kayda değer.

# Haber listesi sunucusu (Cloudflare Worker)

Sitedeki "Ücretli sürüm çıkınca haber ver" formunu bu küçük sunucu karşılar. Kod hazır ama **yayında değil**. Aşağıdaki adımları sen yaptığında çalışmaya başlar.

Ne yapar:

- Formdan gelen e-postayı ve isteğe bağlı cevapları kaydeder, ziyaretçiyi sitedeki `thanks.html` sayfasına gönderir.
- Aynı adres ikinci kez gelirse yeni kayıt açmaz, cevapları günceller.
- Her e-postaya koyacağın listeden çıkma bağlantısı (`/unsubscribe?token=...`) kaydı siler ve `unsubscribed.html` sayfasına gönderir.
- Aynı yerden saatte 5'ten fazla kayıt gelirse durdurur. Bunun için IP adresini **saklamaz**; yalnızca gizli bir anahtarla üretilmiş, her gün değişen bir özeti en fazla 24 saat tutar.
- Başka hiçbir hizmete bağlanmaz. Çerez yok.

Dosyalar:

| Dosya | Ne işe yarar |
|---|---|
| `src/index.js` | Sunucunun kendisi |
| `src/lib.js` | Doğrulama ve temizleme (testleri `test/waitlist-worker.test.js` içinde) |
| `schema.sql` | Veritabanı tabloları |
| `wrangler.toml` | Ayarlar. İki boş değeri sen dolduracaksın |

Bütün komutlar ücretsiz; Cloudflare'in ücretsiz planı bu iş için fazlasıyla yeter. Kart bilgisi gerekmez.

## Adımlar

### 1. Cloudflare hesabı aç

<https://dash.cloudflare.com/sign-up> adresinden e-posta ve şifreyle ücretsiz hesap aç, e-postanı doğrula.

### 2. Terminali bu klasörde aç

```powershell
cd C:\Users\user1\Documents\Projects\windows-ai-usage-monitor\worker\waitlist
```

Node.js zaten kurulu. `npx` gereken aracı (wrangler) ilk seferde kendisi indirir; "Ok to proceed?" sorarsa `y` yaz.

### 3. Cloudflare'e giriş yap

```powershell
npx wrangler login
```

Tarayıcı açılır, "Allow" de. Terminalde "Successfully logged in" yazmalı.

### 4. Veritabanını oluştur

```powershell
npx wrangler d1 create limitpeek-waitlist --location=weur
```

`weur` Batı Avrupa demek (KVKK ve GDPR açısından en sade seçim). Çıktıda şuna benzer bir satır olur:

```
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Bu değeri `wrangler.toml` içindeki `database_id = ""` satırına yapıştır.

### 5. Tabloları kur

```powershell
npx wrangler d1 execute limitpeek-waitlist --remote --file=schema.sql
```

### 6. Gizli anahtarı ekle

Önce rastgele bir değer üret:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Sonra:

```powershell
npx wrangler secret put IP_SALT
```

Sorduğunda az önce ürettiğin değeri yapıştır. Bu değeri hiçbir yere yazma; kaybolursa yenisini üretip aynı komutla değiştirmen yeter.

### 7. Sitenin adresini yaz

`wrangler.toml` içinde `SITE_URL = ""` satırına sitenin adresini **sonunda `/` ile** yaz, örneğin:

```toml
SITE_URL = "https://limitpeek.pages.dev/"
```

Site henüz yayında değilse önce siteyi yayımla (Cloudflare Pages ücretsiz bir `*.pages.dev` adresi verir).

### 8. Sunucuyu yayımla

```powershell
npx wrangler deploy
```

Çıktının sonunda sunucunun adresi yazar:

```
https://limitpeek-waitlist.<senin-alt-alanin>.workers.dev
```

### 9. Siteyi bu adrese bağla (iki yer)

`site/index.html` içinde:

1. **RELEASE CONFIG** bloğunda:
   ```json
   "waitlistUrl": "https://limitpeek-waitlist.<senin-alt-alanin>.workers.dev/"
   ```
2. En üstteki `Content-Security-Policy` satırında `form-action 'none'` yazan yeri şununla değiştir:
   ```
   form-action 'self' https://limitpeek-waitlist.<senin-alt-alanin>.workers.dev
   ```
   Sonunda `/` yok. `'self'` şart: form gönderildikten sonra tarayıcı teşekkür sayfasına yönlendirmeyi de bu kurala göre denetler.

İkisi uyuşmazsa form kapalı kalır ve şu komut hata verir. Uyuşunca "OK" yazar:

```powershell
cd C:\Users\user1\Documents\Projects\windows-ai-usage-monitor
node scripts/check-site-config.js
```

`npm test` de aynı denetimi yapar.

### 10. Gizlilik sayfasını tamamla

`site/privacy.html` içindeki sarı yer tutucuları doldur: bölge (`[bölge, ör. Batı Avrupa]`), ad, destek e-postası. Sonra siteyi yeniden yayımla.

### 11. Dene

Sitede formu kendi adresinle gönder; teşekkür sayfası açılmalı. Kaydı gör:

```powershell
npx wrangler d1 execute limitpeek-waitlist --remote --command "SELECT email, tools, price, feature, locale, created_at FROM subscribers"
```

## Sonra işine yarayacaklar

**Listeyi indirmek** (duyuru göndermeden önce):

```powershell
npx wrangler d1 execute limitpeek-waitlist --remote --json --command "SELECT email, locale, token FROM subscribers" > liste.json
```

`liste.json` kişisel veri içerir: kimseyle paylaşma, işin bitince sil, depoya ekleme.

**Cevapların özeti:**

```powershell
npx wrangler d1 execute limitpeek-waitlist --remote --command "SELECT price, COUNT(*) AS kisi FROM subscribers GROUP BY price"
```

**Her e-postaya listeden çıkma bağlantısı koy** (gizlilik sayfası bunu söz veriyor):

```
https://limitpeek-waitlist.<senin-alt-alanin>.workers.dev/unsubscribe?token=<o kişinin token değeri>
```

E-posta hizmeti destekliyorsa aynı adresi `List-Unsubscribe` başlığına da koy ve `List-Unsubscribe-Post: List-Unsubscribe=One-Click` ekle; sunucu bunu da anlar. Bir e-posta hizmeti kullanacaksan, ilk gönderimden önce adını gizlilik sayfasına yaz.

**Ücretli sürümü duyurduktan 30 gün sonra listeyi sil** (gizlilik sayfasındaki söz):

```powershell
npx wrangler d1 execute limitpeek-waitlist --remote --command "DELETE FROM subscribers"
```

**Birinin kaydını elle silmek** (e-postayla isterse):

```powershell
npx wrangler d1 execute limitpeek-waitlist --remote --command "DELETE FROM subscribers WHERE email = 'ornek@adres.com'"
```

**Hata olursa canlı kayıtları izlemek:** `npx wrangler tail`. Cloudflare panelinde "Logpush" ya da kalıcı günlük açma; açarsan IP adresleri saklanmış olur ve gizlilik sayfası yanlış olur.

## Dikkat

- **Cloudflare Web Analytics'in betiğini açma.** Pages ayarlarındaki "Web Analytics" sayfaya Cloudflare'in bir betiğini ekler. Hem sitenin güvenlik kuralı (CSP) onu engeller hem de "bu sayfa dışarıya istek göndermez" sözü bozulur. Ziyaretçi sayısını betiksiz, Cloudflare panelindeki sunucu tarafı istek sayılarından izle.
- **Çift onay yok.** Formu biri başkasının adresiyle de gönderebilir. İlk duyuruyu "bu listeye siz mi yazıldınız? İstemiyorsanız buradan çıkın" diye başlatmak yeterli bir önlem.
- **E-posta güvenlik tarayıcıları.** Bazı şirket e-posta sistemleri gelen bağlantıları otomatik açar; bu, çıkma bağlantısını da açıp kişiyi listeden çıkarabilir. Zararı küçük (kişi listeden düşer), ama bilmekte yarar var.
- Sunucunun adresini değiştirirsen 9. adımı yeniden yap.

## Kaldırmak

```powershell
npx wrangler delete
npx wrangler d1 delete limitpeek-waitlist
```

Sonra `site/index.html` içinde `waitlistUrl`'yi boşalt ve `form-action`'ı yeniden `'none'` yap.

# Ağ denetimi: Usage Notch 0.6.8, 30 Eylül 2026

**Sonuç: GEÇTİ.** Uygulama 16 dakika boyunca tek bir ağ bağlantısı açmadı. Buna internet, yerel ağ ve bilgisayarın kendi içindeki bağlantılar da dahil.

| | |
|---|---|
| Ölçülen sürüm | 0.6.8 (master 1184ce5; kurulum paketiyle aynı app.asar, sha256 915db2af…) |
| Süre | 15:54:58 – 16:11:00 (16 dakika), Windows 11 26200 |
| Yöntem | `scripts/zero-socket-audit.ps1 -Case A -Minutes 16`, yönetici olarak |
| Ölçüm kaynağı | Windows çekirdeğinin ağ olay kaydı (ETW, `Microsoft-Windows-Kernel-Network`). Her TCP ve UDP olayını, sahibi olan işlemle birlikte yazar. |
| İzlenen işlemler | Uygulamanın 4 işleminin hepsi: ana işlem, GPU, panel ve Chromium'un ağ servisi |
| Bulunan ağ olayı | **0**; bilgisayarın kendi içindeki bağlantılar da 0 |
| Anlık soket örneklemesi | 0 satır (2 saniyede bir, 178 kez) |
| Kayıp olay tamponu | 0 (1039 tampon yazıldı, hiçbiri kaybolmadı) |
| Kontrol | Kayıt okuyucu aynı dosyadan başka programların olaylarını okuyabildi. Yani sıfır, bozuk bir ölçümden değil gerçek bir sıfırdan geliyor. |
| Uygulama çalışır durumdaydı mı? | Evet. 16 dakika boyunca açık kaldı ve panel yüklendi. |

Bu klasördeki dosyalar:
- `summary.json`: ölçümün tam özeti.
- `console.log`: denetim betiğinin çıktısı.
- `kernel-network-events.json`, `samples.json`: bulunan olaylar. Her ikisi de boş liste (`[]`).

Kişisel yollar `%USERPROFILE%` ya da `USER` ile değiştirildi. Makine bilgisi satırları çıkarıldı.

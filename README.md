# Repo Compiler

GitHub repolarını tek tıkla masaüstü uygulamasına (`.exe` / `.app` / Linux binary) dönüştüren, Electron tabanlı bir araç. Bir repo linki yapıştırırsınız; uygulama repoyu indirir, projeyi analiz eder, bağımlılıkları kurar, derler ve sonucu `Compiled Repos/<Repo-Adı>/` klasörüne taşır.

Arayüz, F-Droid ve Google Play Store'dan esinlenen kart tabanlı bir tasarıma sahiptir: ripple efektleri, yumuşak geçişler, açık/koyu tema ve seçilebilir vurgu rengi.

## Özellikler

- **Tek alandan derleme:** GitHub linkini yapıştırın, `Derle`'ye basın. Belirli bir dal için `https://github.com/kullanici/repo/tree/dal-adi` biçimi desteklenir.
- **Otomatik proje tespiti:**
  - `package.json` içinde `electron` varsa proje olduğu gibi paketlenir.
  - `build` betiği olan web projeleri (Vite, React vb.) `npm run build` ile derlenir ve bir Electron kabuğuna sarılır.
  - Saf HTML/CSS/JS projeleri doğrudan Electron kabuğuna sarılır.
- **Canlı takip:** Terminal çıktısı, adım göstergesi (İndirme, Analiz, Kurulum, Derleme, Paketleme, Taşıma) ve ilerleme çubuğu. Derleme istenirse iptal edilebilir.
- **Geçmiş:** Önceki derlemeler kartlar halinde listelenir. Kartlardan uygulamayı çalıştırabilir, klasörünü açabilir, başarısız derlemeyi tekrar deneyebilir veya kaydı (isteğe bağlı olarak dosyalarıyla birlikte) silebilirsiniz.
- **Ayarlar:** Çıktı klasörü, hedef platform ve mimari, Electron sürümü, `--legacy-peer-deps`, geçici klasörü koruma.
- **Görünüm:** Açık / koyu / sistem teması, 8 hazır vurgu rengi ve özel renk seçici.

## Gereksinimler

- [Node.js](https://nodejs.org) 18 veya üzeri (npm ve npx ile birlikte)
- [Git](https://git-scm.com), `PATH` içinde
- İnternet bağlantısı (repo, npm paketleri ve Electron ikilisi indirilir)

## Kurulum ve çalıştırma

```bash
git clone https://github.com/<kullanici>/repo-compiler.git
cd repo-compiler
npm install
npm start
```

## Paketleme

Uygulamanın kendisini [electron-builder](https://www.electron.build) ile paketleyebilirsiniz:

```bash
npm run dist          # Windows: tek dosyalık portable .exe
npm run dist:mac      # macOS: .dmg
npm run dist:linux    # Linux: AppImage
```

Çıktılar `release/` klasörüne yazılır.

## Kullanım

1. **Compile a Repo** sekmesinde GitHub repo linkini yapıştırın ve `Derle`'ye basın.
2. Canlı log ve ilerleme çubuğundan süreci izleyin.
3. Bittiğinde uygulama `Compiled Repos/<Repo-Adı>/` altında hazırdır. Geçmiş kartından `Çalıştır` veya `Klasör` ile açabilirsiniz.

### Çıktı klasörü

Varsayılan olarak `Compiled Repos` klasörü şu konuma oluşturulur:

- geliştirme modunda proje klasörünün içine,
- paketlenmiş uygulamada `.exe`'nin yanına (portable sürümde `PORTABLE_EXECUTABLE_DIR`).

Bu konuma yazılamıyorsa Belgeler klasörü kullanılır. **Settings** sekmesinden istediğiniz klasörü seçebilirsiniz.

Aynı repoyu yeniden derlerseniz önceki `Compiled Repos/<Repo-Adı>/` klasörü silinip yerine yenisi konur.

## Nasıl çalışır?

1. Gereksinimler denetlenir (`git`, `npm`).
2. Repo, geçici bir klasöre `git clone --depth 1` ile indirilir.
3. Proje türü tespit edilir (Electron, web build veya saf web).
4. Gerekirse `npm install` ve `npm run build` çalıştırılır.
5. Web projeleri için, içeriği yerel bir sunucu üzerinden gösteren küçük bir Electron kabuğu (`wrapper-main.js`) oluşturulur. Bu sayede mutlak yollar (`/assets/...`) ve SPA yönlendirmeleri çalışır.
6. `npx @electron/packager` ile masaüstü uygulaması paketlenir.
7. Çıktı klasörü `Compiled Repos/<Repo-Adı>/` altına taşınır, geçici dosyalar silinir.

## Proje yapısı

```
repo-compiler/
├─ main.js            # Ana süreç: pencere, IPC, ayarlar ve geçmiş
├─ preload.js         # Güvenli köprü (contextBridge)
├─ compiler.js        # İndirme, analiz, derleme ve paketleme akışı
├─ wrapper-main.js    # Web projeleri için üretilen Electron kabuğunun şablonu
├─ index.html         # Arayüz iskeleti
├─ style.css          # Tema ve bileşen stilleri
├─ renderer.js        # Arayüz mantığı
└─ package.json       # Bağımlılıklar ve electron-builder yapılandırması
```

`wrapper-main.js`, electron-builder'ın `extraResources` ayarıyla `app.asar` dışına, `resources/` klasörüne kopyalanır. Paketlenmiş uygulama dosyayı `process.resourcesPath` üzerinden okur.

Ayarlar ve geçmiş, Electron'un `userData` klasöründe `store.json` olarak saklanır.

## Desteklenen ve desteklenmeyen projeler

| Proje türü | Durum |
| --- | --- |
| `electron` bağımlılığı olan proje | Desteklenir |
| `build` betiği olan web projesi (Vite, CRA, Vue CLI vb.) | Desteklenir; çıktı `dist`, `build` veya `out` içinde `index.html` içermelidir |
| Saf HTML/CSS/JS | Desteklenir |
| Sunucu odaklı Node projeleri (Express vb.) | Desteklenmez |
| `next export` yapılandırması olmayan Next.js | Desteklenmez |

## Güvenlik

Derleme sırasında reponun `npm install` betikleri ve `build` komutu bilgisayarınızda çalışır. **Yalnızca güvendiğiniz repoları derleyin.**

Arayüz `contextIsolation` ve `sandbox` açıkken çalışır; Node erişimi yalnızca ana süreçtedir. Repo linki, çalıştırılan komutlara geçmeden önce katı bir biçimde doğrulanır.

## Sorun giderme

| Sorun | Çözüm |
| --- | --- |
| `"git" bulunamadı` / `"npm" bulunamadı` | Git ve Node.js'i kurun, `PATH` içinde olduklarından emin olup uygulamayı yeniden başlatın. |
| `ENOENT ... wrapper-main.js` | `wrapper-main.js` proje kökünde olmalı ve `package.json` içindeki `extraResources` ayarı korunmalı. `release/` klasörünü silip yeniden paketleyin. |
| `Eski klasör silinemedi` | Daha önce derlenen uygulama açık olabilir. Kapatıp tekrar deneyin. |
| `Derleme çıktısı bulunamadı` | Projenin build betiği `dist`, `build` veya `out` içinde `index.html` üretmiyor olabilir. |
| Peer dependency hataları | Settings sekmesinde `--legacy-peer-deps` seçeneğini açın. |
| Hata ayıklamak istiyorum | Settings sekmesinde `Geçici klasörü koru` seçeneğini açın; log sonunda klasörün yolu yazılır. |

## Lisans

MIT

# گزارش بررسی شاخه‌های Remote — «Push شده ولی به main نرفته» (۲۰۲۶-۱۰-۰۶)

**دستور مالک:** «فایل‌هایی که پوش شدن ولی مین نشدن رو بررسی کن ببین چه فایل‌هایی هستند، بعد یه گزارش کامل»
**وضعیت sync در شروع این بررسی:** remote `main` = remote `integration/reconcile-lineages` = محلی = **`6477df5`** (همه‌چیز push شده؛ درخت تمیز).

---

## ۱) روش بررسی

برای هر ۲۳ شاخه remote (به‌جز main خودش):
- `git rev-list --count main..branch` — چند کامیت جلوتر از main است؛
- `git cherry main branch` — آیا patch کامیت‌ها از راه دیگری (مثلاً squash-merge) در main هست؛
- diff سطح فایل (سه‌نقطه و دونقطه) — چه فایل‌هایی واقعاً در main نیستند؛
- GitHub API — وضعیت واقعی ۹ PR (باز/بسته/merge).

## ۲) نتیجه کلی — هیچ کار از دست نرفته است

| دسته | تعداد | شاخه‌ها | وضعیت |
|---|---|---|---|
| کاملاً در main (0 کامیت جلوتر) | **۱۸** | `feat/telegram-journal-client`، `feat/web-full-frontend`، `feat/mg-domain-*` (هر سه)، `feat/mg-obs-*` (هر دو)، `feat/mg-range-guard`، `feat/mg-backup-restore-local-drill`، `feat/roadmap-schema-0015-0022`، `reconcile/foundation-first`، `staging`، `deploy/staging-contract-repair`، `docs/mg-obs-7-evidence-precision`، `governance/agent-context`، `migration/backend-modern-pass1`، `backup/main-before-…` | ✅ همه محتوایشان در main است |
| محتوا از راه squash-merge در main | **۳** | `retention/activation` (PR #2 → کامیت `df27a2a`)، `promotion/backup-gate` (PR #3 → `c904344`)، `promotion/p1-backup-files` (PR #5 → کامیت `351ce16`)، `promotion/adr-012` (PR #4 → `41761ae`) | ✅ merge شده‌اند؛ patch-id فرق دارد چون squash بوده |
| خودِ زنجیره ادغام | ۱ | `integration/reconcile-lineages` | ✅ = main (`6477df5`) |
| محتوای واقعاً ادغام‌نشده | **۱** | `feature/phase-6f-frontend-parity` | ⚠️ تفصیل در §۳ — **منسوخ، نه گمشده** |

**وضعیت PRها:** هر ۹ PR ریپو closed+merged هستند — هیچ PR بازی وجود ندارد.

## ۳) تنها شاخه با محتوای ادغام‌نشده: `feature/phase-6f-frontend-parity`

**۱۲ کامیت، ۲۰۲۶-۰۹-۲۲، ۲۱۷ فایل (+۱۵٬۶۸۴ خط)** — یک فرانت‌اند کامل در پوشه `web/` (ریشه ریپو؛ چیدمان پیش از بازساخت monorepo).

### چرا منسوخ است، نه گمشده
دو روز بعد از آن، **PR #7 (`feat/web-full-frontend`، ۲۰۲۶-۰۹-۲۴، «W0–W5 full frontend closure — 110/110 verification»)** merge شد که فرانت‌اند واقعی ریپو را در `apps/web` ساخت — و main الان نسخه‌های پیشرفته‌تر همه آن سطوح را دارد.

### مقایسه صفحه‌به‌صفحه (۱۷ صفحه phase-6f ↔ معادل در main)

| صفحه در phase-6f | معادل در `apps/web` (main) |
|---|---|
| login / register / forgot-password / reset-password / verify-email / صفحه اصلی | ✅ همه موجود (+ نسخه en) |
| dashboard / intelligence / markets / news / performance / profile / support / wallet / trades | ✅ همه موجود (+ fa/en + admin، analytics، settings، **blog**، **checkout** که phase-6f اصلاً نداشت) |
| `trades/new` (فرم ثبت معامله) | ✅ به‌صورت قابلیت در خود صفحه trades (createTrade → POST /api/v1/trades) |
| `accounts/connect` (اتصال بروکر) | ✅ کامل‌تر از آن: جریان سه‌مرحله‌ای مدرن در صفحه accounts — detectServer → createAccount → createCredential → connectMetaApi/disconnectMetaApi → triggerSync |

### تنها چیز قابل‌نجات از این شاخه
- **۶۹ فایل asset** (آیکون نمادها/دارایی‌ها + پرچم‌ها) — `apps/web` فعلاً فقط ۱۴ فایل public دارد (favicon/فونت/landing) و از این آیکون‌ها استفاده نمی‌کند؛
- ۲۴ فایل پیام locale (`web/messages/{en,fa}`) — محتوایشان از راه رشته‌های درون apps/web پوشش داده شده؛
- ۱۴ اسکرین‌شات QA تاریخی (`docs/migration/qa-screens`) — ارزش آرشیوی.

**→ تصمیم مالک (کاندیدای OD-11):** آیا UI آیکون نماد/احساس (سبک Legacy) در سطوح معاملات خواسته می‌شود؟ اگر بله، assetها به‌عنوان «classic-design Velora» از این شاخه به `apps/web/public` منتقل می‌شوند؛ اگر نه، شاخه آرشیو/حذف می‌شود. قابلیت (نمایش معاملات با نماد/احساس متنی) از قبل در main هست — این فقط تصمیم بصری است.

## ۴) نکته درباره `retention/activation` (PR #2)

محتوایش در main هست؛ تنها تفاوت باقی‌مانده با main این است که شاخه cron را **هفتگی** کرده بود و main الان **روزانه** (`30 3 * * *`، فقط گزارش‌دهی؛ قانون retention هر دو یکسان: ۱۴ روز). چون **GitHub Actions طبق سیاست هزینه مالک اصلاً غیرفعال است**، این تفاوت عملاً بی‌اثر است. هیچ اقدامی لازم نیست.

## ۵) جمع‌بندی

1. **هیچ فایل push‌شده‌ای «جا مانده از main» وجود ندارد** — به‌جز شاخه منسوخ phase-6f که تمام قابلیت‌هایش در main پوشش داده شده (بالا رو ببینید).
2. `main` (`6477df5`) اکنون **کل خط تولید** را دارد: کمپین governance + هر دو lineage + ادغام AC-27 + کارزار AC-28..AC-40 (assembly، امنیت، وب، ایمیل‌ها، RBAC، کادنس، ops:verify، شواهد runtime ورکر، دریل backup/restore، گزارش فارسی، سوابق sync/promotion).
3. پیش از هر push در این بررسی: secret-scan **PASS (صفر یافته)**؛ پس از هر push: تأیید `ls-remote`.
4. **پیشنهاد پاک‌سازی (اختیاری، تصمیم مالک):** شاخه‌های merge‌شده remote (۲۲ مورد) را می‌توان حذف کرد تا نمای ریپو تمیز شود — محتوای همه‌شان در main امن است. من بدون دستور صریح چیزی حذف نمی‌کنم.

## ۶) ادامه کار (صف بعدی مهاجرت)

این بررسی ترتیب صف را عوض نمی‌کند: (۱) پاسخ به ۱۰ تصمیم باز مالک (+ OD-11 جدیدِ آیکون‌ها)؛ (۲) موج دوم PARTIALهای محصول در main: ۷۶ مسیر API باقی‌مانده، سطوح admin/blog/… در فرانت، نگاشت i18n باقی‌مانده، ۸+ جدول Legacy بدون مقصد؛ (۳) موارد نیازمند دسترسی بیرونی (deploy واقعی، MetaAPI/تلگرام زنده، آپلود offsite پشتیبان).

— ایجنت مهاجرت، ۲۰۲۶-۱۰-۰۶، بر پایه git تا `6477df5` + GitHub API (وضعیت PRها در لحظه).

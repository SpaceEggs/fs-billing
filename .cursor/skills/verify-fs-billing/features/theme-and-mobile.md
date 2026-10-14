# Theme and mobile layout

Users pick a light, dark, or follow-system theme. The choice applies at once, persists in `localStorage` across reloads, and in system mode tracks the OS color scheme live. On a 375px phone, the shell switches to a mobile header with a `☰` navigation drawer and an avatar that opens a bottom sheet. The sheet shows the account, a segmented theme picker, and logout, and the content fits without horizontal scrolling.

## Sub-features

- `desktop-dark`: `button '主题'` (◐) opens `menuitemradio '深色'`. Choosing it sets `html[data-theme=dark]` and `localStorage['fs-billing.theme'] = 'dark'`, and the theme is still dark after a reload.
- `desktop-light`: `menuitemradio '浅色'` sets `light` and stores `light`.
- `system`: `menuitemradio '跟随系统'` stores `system`, and `data-theme` follows `prefers-color-scheme` dark and light live, without a reload.
- `mobile-layout`: at 375×812 the portal home shows `region '当前余额'` with `-¥35.20` and `button '打开导航'`, and `scrollWidth` ≤ 375.
- `account-sheet`: `button '账号菜单'` opens `dialog '账号菜单'` with `abc001@example.com`, `深圳市某某科技有限公司 · ABC001`, and `radiogroup '主题'`. Choosing `深色` makes `radio '深色'` checked and the theme dark.
- `nav-drawer`: `button '打开导航'` opens `dialog '导航'`, whose `link '首页'` has `aria-current=page`.

## How to get to it (user POV)

- Desktop, signed in: the ◐ button in the top bar.
- Mobile, signed in: avatar, then the `主题` segmented control in the account sheet.
- The OS appearance setting, when the preference is `跟随系统` (the default, with nothing stored).
- Any page at a narrow viewport (phone, or a narrow window under 768px).

## Driving it with Playwright (drive.mjs)

Preconditions:

- `$S/doctor.sh` is healthy. `abc001@example.com` is not locked.
- The browser context starts with `colorScheme: 'light'` and empty `localStorage`. Each journey context is new.

- **Whole journey.** Run `$S/drive.mjs theme-and-mobile`. Exit `0`, six steps PASS.
- **Dark and persistence.** Log in as `abc001`. Click `button '主题'`; `menu` shows three radios (`01-theme-menu.aria.yml`). Click `menuitemradio '深色'`. The page has `html[data-theme=dark]` and storage `dark`. Reload: the theme is still `dark` (`02-dark-after-reload.png`).
- **Light.** Use `主题`, then `浅色`. The page has `data-theme=light` and storage `light`.
- **System.** Use `主题`, then `跟随系统`. Storage is `system`. `page.emulateMedia({ colorScheme: 'dark' })` sets `data-theme=dark`, and `'light'` sets `light`, with no reload.
- **Mobile layout.** In a new 375×812 `isMobile` context, log in. The URL is `/`. The page shows `region '当前余额'` with `-¥35.20` and `button '打开导航'`, and `document.documentElement.scrollWidth` ≤ 375 (`03-mobile-home.png`, `.aria.yml`).
- **Account sheet.** Tap `button '账号菜单'`. `dialog '账号菜单'` shows the email, the tenant line, and `radiogroup '主题'` (`04-account-sheet.aria.yml`). Tap `深色`. The page has `data-theme=dark` and `radio '深色'` checked (`04-account-sheet-dark.png`). Press Escape.
- **Nav drawer.** Tap `button '打开导航'`. `dialog '导航'` has `link '首页'` with `aria-current="page"` (`05-nav-drawer.png`).

## Gotchas

- The theme is applied before React renders, by an inline script in `index.html`, using the same `fs-billing.theme` key. A bad stored value falls back to `system`. Assert `data-theme`, not CSS colors.
- The segmented control uses visually hidden native radios. Click the label text (`getByText('深色')` inside the radiogroup) and assert `getByRole('radio', { name: '深色' })` is checked.
- The breakpoint is `md` (768px). At 640–767px the login page is in desktop layout but the shell is mobile. Use exactly 375px for "mobile" proof.
- The theme preference is per browser (localStorage), not per account. A new context resets it, so persistence must be shown with a reload in the same context.
- The theme menu exists only in the signed-in shell. The login pages have no theme control; they follow the stored or system theme.

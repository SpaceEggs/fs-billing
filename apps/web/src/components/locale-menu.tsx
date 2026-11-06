import { LanguagesIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  DEFAULT_LOCALE,
  isLocale,
  LOCALES,
  LOCALE_NAMES,
  type Locale,
} from '@fs-billing/shared';
import { setLocale } from '../i18n';
import { saveAccountLocale } from '../lib/session';
import { cn } from '../lib/utils';
import { menuContentClass, menuItemClass } from './menu';
import { Button } from './ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';

/**
 * Top-bar language button (Languages icon): Chinese / English.
 * `mobile` is the borderless 40 px button used in the mobile top bar and account sheet;
 * language names keep their native spelling.
 * `signedIn` sends the choice to the account; on the login page only localStorage changes.
 */
export function LocaleMenu({
  mobile = false,
  signedIn = false,
}: {
  mobile?: boolean;
  signedIn?: boolean;
}) {
  const { t, i18n } = useTranslation(['common']);
  const current: Locale = isLocale(i18n.resolvedLanguage)
    ? i18n.resolvedLanguage
    : DEFAULT_LOCALE;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={t('common:locale.label')}
          variant={mobile ? 'ghost' : 'outline'}
          size="icon"
          className={cn(mobile && 'size-10 shrink-0')}
        >
          <LanguagesIcon aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={6}
        className={cn(menuContentClass, 'w-40')}
      >
        <DropdownMenuRadioGroup
          value={current}
          onValueChange={(value) => {
            if (!isLocale(value)) return;
            setLocale(value);
            if (signedIn) void saveAccountLocale(value);
          }}
        >
          {LOCALES.map((locale) => (
            <DropdownMenuRadioItem
              key={locale}
              value={locale}
              indicator="end"
              className={menuItemClass}
            >
              {LOCALE_NAMES[locale]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

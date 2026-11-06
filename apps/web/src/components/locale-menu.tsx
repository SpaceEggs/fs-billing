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
 */
export function LocaleMenu({ mobile = false }: { mobile?: boolean }) {
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
            if (isLocale(value)) setLocale(value);
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

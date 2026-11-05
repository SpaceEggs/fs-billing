import { SunMoonIcon } from 'lucide-react';
import {
  setThemePreference,
  themeOptions,
  useThemePreference,
} from '../lib/theme';
import { cn } from '../lib/utils';
import { OptionTabs } from './option-tabs';
import { Button } from './ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { menuContentClass, menuItemClass } from './menu';

/**
 * 顶部主题按钮（SunMoon 图标）：浅色 / 深色 / 跟随系统。`mobile` 是门户手机顶栏的无边框 40 px 按钮（设计稿 1b）。
 */
export function ThemeMenu({ mobile = false }: { mobile?: boolean }) {
  const preference = useThemePreference();
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="主题"
          variant={mobile ? 'ghost' : 'outline'}
          size="icon"
          className={cn(mobile && 'size-10 shrink-0')}
        >
          <SunMoonIcon aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={6}
        className={cn(menuContentClass, 'w-40')}
      >
        <DropdownMenuRadioGroup
          value={preference}
          onValueChange={(value) =>
            setThemePreference(
              themeOptions.find((option) => option.value === value)?.value ??
                'system',
            )
          }
        >
          {themeOptions.map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              indicator="end"
              className={menuItemClass}
            >
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 主题单选，用于客户门户账号设置和手机账号菜单。 */
export function ThemeSegmented({ className }: { className?: string }) {
  const preference = useThemePreference();
  return (
    <OptionTabs
      label="主题"
      options={themeOptions}
      value={preference}
      onChange={setThemePreference}
      {...(className ? { className } : {})}
    />
  );
}

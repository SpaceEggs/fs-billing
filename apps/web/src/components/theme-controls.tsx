import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  setThemePreference,
  themeOptions,
  useThemePreference,
} from '../lib/theme';
import { cn } from '../lib/utils';
import { buttonVariants } from './ui/button';
import { menuContentClass, menuItemClass } from './menu';

/** 顶部 ◐ 按钮：浅色 / 深色 / 跟随系统。 */
export function ThemeMenu() {
  const preference = useThemePreference();
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger
        aria-label="主题"
        className={cn(buttonVariants({ variant: 'outline', size: 'icon' }))}
      >
        ◐
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className={cn(menuContentClass, 'w-40')}
        >
          <DropdownMenu.RadioGroup
            value={preference}
            onValueChange={(value) =>
              setThemePreference(
                themeOptions.find((option) => option.value === value)?.value ??
                  'system',
              )
            }
          >
            {themeOptions.map((option) => (
              <DropdownMenu.RadioItem
                key={option.value}
                value={option.value}
                className={cn(menuItemClass, 'justify-between')}
              >
                {option.label}
                <DropdownMenu.ItemIndicator>✓</DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** 分段选择器，取自客户门户账号设置的“主题”卡片；手机账号菜单内使用。 */
export function ThemeSegmented({ className }: { className?: string }) {
  const preference = useThemePreference();
  return (
    <div
      role="radiogroup"
      aria-label="主题"
      className={cn(
        'inline-flex gap-0.5 rounded-[9px] bg-muted p-[3px] text-[13px]',
        className,
      )}
    >
      {themeOptions.map((option) => {
        const active = option.value === preference;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => setThemePreference(option.value)}
            className={cn(
              'flex h-[30px] flex-1 items-center justify-center rounded-[7px] px-3.5',
              active
                ? 'bg-background font-medium text-foreground shadow-[0_1px_2px_rgba(0,0,0,.08)]'
                : 'text-muted-foreground',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

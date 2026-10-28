import { useId } from 'react';
import { SunMoonIcon } from 'lucide-react';
import {
  setThemePreference,
  themeOptions,
  useThemePreference,
} from '../lib/theme';
import { cn } from '../lib/utils';
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

/**
 * 分段选择器，取自客户门户账号设置的“主题”卡片；手机账号菜单内使用。
 * 用原生单选框：整组只占一个 Tab 停靠点，方向键切换选项。
 */
export function ThemeSegmented({ className }: { className?: string }) {
  const preference = useThemePreference();
  const name = useId();
  return (
    <div
      role="radiogroup"
      aria-label="主题"
      className={cn(
        'inline-flex gap-0.5 rounded-[9px] bg-muted p-[3px] text-[13px]',
        className,
      )}
    >
      {themeOptions.map((option) => (
        <label
          key={option.value}
          className="relative flex h-[30px] flex-1 cursor-pointer items-center justify-center rounded-[7px] px-3.5 text-muted-foreground has-checked:bg-background has-checked:font-medium has-checked:text-foreground has-checked:shadow-[0_1px_2px_rgba(0,0,0,.08)] has-focus-visible:ring-[3px] has-focus-visible:ring-ring"
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={option.value === preference}
            onChange={() => setThemePreference(option.value)}
            className="absolute inset-0 cursor-pointer appearance-none outline-none"
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}

import * as React from 'react';
import { Tabs as TabsPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

/**
 * shadcn/ui Tabs，样式按设计稿调整：电脑是底边横线、选中项下方加粗主色线，手机是圆角胶囊（选中项主色填充）。
 */
function Tabs({
  className,
  orientation = 'horizontal',
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      orientation={orientation}
      className={cn('group/tabs flex flex-col gap-2', className)}
      {...props}
    />
  );
}

function TabsList({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        'flex gap-2 text-sm md:gap-1 md:border-b md:border-border',
        className,
      )}
      {...props}
    />
  );
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        'inline-flex items-center gap-1.5 px-3 whitespace-nowrap text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*="size-"])]:size-4',
        'max-md:h-10 max-md:rounded-full max-md:border max-md:border-input',
        'md:-mb-px md:border-b-2 md:border-transparent md:py-2.5',
        'data-[state=active]:font-semibold md:data-[state=active]:text-foreground max-md:data-[state=active]:border-primary max-md:data-[state=active]:bg-primary max-md:data-[state=active]:text-primary-foreground md:data-[state=active]:border-primary',
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn('flex-1 outline-none', className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };

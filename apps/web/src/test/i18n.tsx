import type { Locale } from '@fs-billing/shared';
import {
  render,
  type RenderOptions,
  type RenderResult,
} from '@testing-library/react';
import type { ReactElement } from 'react';
import { i18n, initI18n } from '../i18n';

export async function renderWithLocale(
  locale: Locale,
  ui: ReactElement,
  options?: RenderOptions,
): Promise<RenderResult> {
  initI18n();
  await i18n.changeLanguage(locale);
  return render(ui, options);
}

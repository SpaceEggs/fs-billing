import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { render, screen } from '@testing-library/react';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { Alert, AlertDescription } from './alert';

// vitest 在 apps/web 下运行。
const srcDir = join(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return path.endsWith('.tsx') && !path.endsWith('.test.tsx') ? [path] : [];
  });
}

const inlineTags = new Set([
  'a',
  'b',
  'code',
  'em',
  'i',
  'kbd',
  'strong',
  'Link',
]);

/**
 * Alert 是 flex / grid 容器：直接子元素各占一个格子。
 * 返回直接子元素里「文字与其他内容混排」或「行内元素」的调用处，这些都应放进 AlertDescription。
 */
function misplacedInlineAlerts(path: string) {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isJsxElement(node) &&
      node.openingElement.tagName.getText() === 'Alert'
    ) {
      const children = node.children.filter(
        (child) =>
          !(ts.isJsxText(child) && child.containsOnlyTriviaWhiteSpaces),
      );
      const hasText = children.some((child) => ts.isJsxText(child));
      const mixedText = hasText && children.length > 1;
      const inline = children.some(
        (child) =>
          ts.isJsxElement(child) &&
          inlineTags.has(child.openingElement.tagName.getText()),
      );
      if (mixedText || inline) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        found.push(`${relative(srcDir, path)}:${line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('alert', () => {
  it('keeps text, inline code and trailing text in one flowing description', () => {
    render(
      <Alert variant="warning" data-testid="alert">
        <AlertDescription>
          <span>提示</span> 请检查 <code>billing_tenant</code> 配置。
        </AlertDescription>
      </Alert>,
    );
    const alert = screen.getByTestId('alert');
    expect(alert.children).toHaveLength(1);
    const description = alert.children[0];
    expect(description).toHaveAttribute('data-slot', 'alert-description');
    expect(description).toContainElement(screen.getByText('billing_tenant'));
    expect(description?.textContent).toBe('提示 请检查 billing_tenant 配置。');
  });

  it('has no call site with text mixed into, or inline elements directly inside, an Alert', () => {
    const offenders = sourceFiles(srcDir)
      .filter((path) => !path.includes(`${join('components', 'ui')}/`))
      .flatMap(misplacedInlineAlerts);
    expect(offenders).toEqual([]);
  });
});

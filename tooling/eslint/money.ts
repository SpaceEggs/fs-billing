import type { Rule, Scope, SourceCode } from 'eslint';

type Node = Parameters<SourceCode['getScope']>[0];
type FunctionContext = Node & {
  id?: Node | null;
  key?: Node;
  parent?: FunctionContext;
};
type Operation = Extract<
  Rule.Node,
  {
    type:
      | 'AssignmentExpression'
      | 'BinaryExpression'
      | 'UnaryExpression'
      | 'UpdateExpression';
  }
>;

const monetaryName =
  /(?:fee|rate|amount|balance|price|cost|credit|debit|money|overdraft|total|subtotal|费用|费率|金额|余额)/i;
const arithmetic = new Set(['+', '-', '*', '/', '%', '**']);

// 除金额命名外，还跟踪变量初始化与赋值中的来源，防止改名绕过。
export const noNumberMoney: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: '金额必须使用 decimal.js，禁止原生数值运算。' },
    schema: [],
    messages: {
      unsafe: '金额/费率不得使用 number 运算，请使用字符串与 decimal.js。',
    },
  },
  create(context) {
    const source = context.sourceCode;
    const declarations = new Map<
      Scope.Variable | undefined,
      Node | null | undefined
    >();
    const assignments = new Map<Scope.Variable | undefined, Node[]>();

    function symbol(node: Node) {
      if (node.type !== 'Identifier') return undefined;
      let scope: Scope.Scope | null = source.getScope(node);
      while (scope) {
        const variable = scope.set.get(node.name);
        if (variable) return variable;
        scope = scope.upper;
      }
    }

    function monetary(
      node: Node | null | undefined,
      seen = new Set<Scope.Variable>(),
    ): boolean {
      if (!node) return false;
      if (node.type === 'Identifier') {
        if (monetaryName.test(node.name)) return true;
        const variable = symbol(node);
        if (!variable || seen.has(variable)) return false;
        seen.add(variable);
        return (
          monetary(declarations.get(variable), seen) ||
          (assignments.get(variable) ?? []).some((value) =>
            monetary(value, new Set(seen)),
          )
        );
      }
      if (node.type === 'MemberExpression') {
        return (
          monetary(node.object, seen) ||
          (node.computed
            ? monetary(node.property, seen) ||
              (node.property.type === 'Literal' &&
                typeof node.property.value === 'string' &&
                monetaryName.test(node.property.value))
            : monetaryName.test(
                (node.property as { name?: string }).name ?? '',
              ))
        );
      }
      if (node.type === 'Literal') {
        return typeof node.value === 'number' && !Number.isInteger(node.value);
      }
      if (
        node.type === 'BinaryExpression' ||
        node.type === 'LogicalExpression'
      ) {
        return (
          monetary(node.left, new Set(seen)) ||
          monetary(node.right, new Set(seen))
        );
      }
      if (node.type === 'CallExpression' || node.type === 'NewExpression') {
        return (
          monetary(node.callee, new Set(seen)) ||
          node.arguments.some((arg) => monetary(arg, new Set(seen)))
        );
      }
      if (node.type === 'ConditionalExpression') {
        return (
          monetary(node.consequent, new Set(seen)) ||
          monetary(node.alternate, new Set(seen))
        );
      }
      if (
        [
          'TSAsExpression',
          'TSNonNullExpression',
          'UnaryExpression',
          'AwaitExpression',
        ].includes(node.type)
      ) {
        const wrapper = node as { expression?: Node; argument?: Node };
        return monetary(wrapper.expression ?? wrapper.argument, seen);
      }
      return false;
    }

    function contextIsMoney(node: Rule.Node) {
      let parent: Rule.Node | null = node.parent;
      while (parent) {
        if (parent.type === 'VariableDeclarator') return monetary(parent.id);
        if (parent.type === 'AssignmentExpression')
          return monetary(parent.left);
        if (parent.type === 'Property') return monetary(parent.key);
        if (parent.type === 'ReturnStatement') {
          while (parent && !/Function/.test(parent.type))
            parent = parent.parent;
          const functionContext = parent as FunctionContext | null;
          return (
            monetary(functionContext?.id) ||
            monetary(functionContext?.parent?.id) ||
            monetary(functionContext?.parent?.key)
          );
        }
        if (/Function/.test(parent.type)) {
          const functionContext = parent as FunctionContext;
          return (
            monetary(functionContext.id) ||
            monetary(functionContext.parent?.id) ||
            monetary(functionContext.parent?.key)
          );
        }
        if (/Statement/.test(parent.type)) return false;
        parent = parent.parent;
      }
      return false;
    }

    const pending: Operation[] = [];
    const calls: Extract<Rule.Node, { type: 'CallExpression' }>[] = [];
    function check(node: Operation) {
      pending.push(node);
    }

    function trackPattern(pattern: Node, value: Node | null | undefined) {
      if (pattern.type === 'Identifier') {
        declarations.set(symbol(pattern), value);
      } else if (pattern.type === 'ObjectPattern') {
        for (const property of pattern.properties) {
          if (property.type === 'Property') {
            trackPattern(
              property.value,
              monetary(property.key) ? property.key : value,
            );
          }
        }
      } else if (pattern.type === 'AssignmentPattern') {
        trackPattern(pattern.left, value);
      }
    }

    return {
      VariableDeclarator(node) {
        trackPattern(node.id, node.init);
      },
      AssignmentExpression(node) {
        if (node.left.type === 'Identifier') {
          const variable = symbol(node.left);
          assignments.set(variable, [
            ...(assignments.get(variable) ?? []),
            node.right,
          ]);
        }
        if (node.operator !== '=') check(node);
      },
      BinaryExpression(node) {
        if (arithmetic.has(node.operator)) check(node);
      },
      UnaryExpression(node) {
        if (['+', '-'].includes(node.operator)) check(node);
      },
      UpdateExpression: check,
      CallExpression(node) {
        calls.push(node);
      },
      'Program:exit'() {
        for (const node of pending) {
          const operation: { left?: Node; argument?: Node; right?: Node } =
            node;
          if (
            monetary(operation.left ?? operation.argument) ||
            monetary(operation.right) ||
            contextIsMoney(node)
          ) {
            context.report({ node, messageId: 'unsafe' });
          }
        }
        for (const node of calls) {
          const callee = node.callee;
          const native =
            (callee.type === 'Identifier' &&
              ['Number', 'parseFloat', 'parseInt'].includes(callee.name)) ||
            (callee.type === 'MemberExpression' &&
              callee.object.type === 'Identifier' &&
              callee.object.name === 'Math');
          if (
            native &&
            (node.arguments.some((arg) => monetary(arg)) ||
              contextIsMoney(node))
          ) {
            context.report({ node, messageId: 'unsafe' });
          }
        }
      },
    };
  },
};

export default { rules: { 'no-number-money': noNumberMoney } };

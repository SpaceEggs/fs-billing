/** a 与 b 是否相差不超过一次编辑（替换、插入或删除一个字符），忽略大小写。 */
export function withinOneEdit(a: string, b: string): boolean {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (Math.abs(left.length - right.length) > 1) return false;
  const [short, long] =
    left.length <= right.length ? [left, right] : [right, left];
  let i = 0;
  while (i < short.length && short[i] === long[i]) i++;
  if (i === short.length) return true;
  // 第一个不同处：替换（等长，跳过两边各一个）或在较长的一边删除一个。
  return (
    short.slice(short.length === long.length ? i + 1 : i) === long.slice(i + 1)
  );
}

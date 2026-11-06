type PluralBase<Key extends string> = Key extends `${infer Base}_one`
  ? Base
  : Key extends `${infer Base}_other`
    ? Base
    : Key;

type Shape<Value> = Value extends string
  ? string
  : Value extends readonly unknown[]
    ? Value
    : Value extends object
      ? { [Key in keyof Value as PluralBase<Key & string>]: Shape<Value[Key]> }
      : Value;

/**
 * 英文文案必须与中文同形：键集合相同，嵌套结构相同。
 * 复数后缀 `_one` / `_other` 归到同一个基键，所以英文可以有两项而中文只有一项。
 */
export type DeepSameShape<Chinese, English> =
  Shape<Chinese> extends Shape<English>
    ? Shape<English> extends Shape<Chinese>
      ? English
      : never
    : never;

export interface FormatterCommandConfig
{
    readonly extensions: readonly string[];
    readonly command: readonly string[];
}

export interface FormattersConfig
{
    readonly formatters: Readonly<Record<string, FormatterCommandConfig>>;
}

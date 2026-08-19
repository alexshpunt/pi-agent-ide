export interface LintCommandConfig
{
    readonly extensions: readonly string[];
    readonly command: readonly string[];
}

export interface LintersConfig
{
    readonly linters: Readonly<Record<string, LintCommandConfig>>;
}

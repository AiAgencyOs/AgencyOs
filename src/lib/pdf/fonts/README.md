# Vendored fonts

Noto Sans Regular and Bold, © The Noto Project Authors, SIL Open Font
License 1.1 (see ./LICENSE). Sourced from the `@expo-google-fonts/noto-sans`
npm package (0.4.2), then subset with fontTools so the whole file can be
embedded in every quotation PDF:

    pyftsubset NotoSans_400Regular.ttf \
      --unicodes="U+0020-007E,U+00A0-00FF,U+0100-017F,U+2000-206F,U+20A0-20CF,U+2212,U+2318,U+FFFD" \
      --layout-features='kern,liga' --name-IDs='*' --notdef-outline \
      --output-file=NotoSans_400Regular.subset.ttf

Why pre-subset instead of pdf-lib's `subset: true`: pdf-lib's at-embed-time
subsetting produces fonts that Apple's CoreGraphics (iPhone, macOS Preview —
where a WhatsApp-delivered PDF is actually opened) renders with most glyphs
missing, while Chrome and Acrobat render them fine. Embedding a pre-subset
font whole avoids that entire failure class. The ranges cover Latin,
punctuation, currency (₹ U+20B9) and the minus sign U+2212 that
`Intl.NumberFormat` output and the app's own copy use; characters outside
them are replaced with '?' by the renderer and reported, never crashed on.

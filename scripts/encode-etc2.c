// Opaque ETC2 RGB8 pages. Khronos Data Format Specification, chapters 21–22.
// Planar mode preserves gradients. Individual/differential mode preserves
// contrast when a plane cannot represent the surface. No runtime dependencies.
typedef unsigned char u8;
typedef unsigned int u32;

static const int luminance[8][2] = {{2, 8},   {5, 17},  {9, 29},   {13, 42},
                                    {18, 60}, {24, 80}, {33, 106}, {47, 183}};
static const int partition_pixels[2][2][8] = {
    {{0, 1, 4, 5, 8, 9, 12, 13}, {2, 3, 6, 7, 10, 11, 14, 15}},
    {{0, 1, 2, 3, 4, 5, 6, 7}, {8, 9, 10, 11, 12, 13, 14, 15}}};
static int clamp(int value, int low, int high) {
  return value < low ? low : value > high ? high : value;
}
typedef struct {
  int table;
  u32 selectors;
  int error;
} Palette;

static Palette fit_palette(const u8 pixels[16][3], const int indices[8],
                           const int base[3]) {
  int signed_sum[8], counts[9] = {0}, sums[9] = {0};
  int total_error = 0, total_magnitude = 0, maximum = 0;
  for (int i = 0; i < 8; i++) {
    const u8 *p = pixels[indices[i]];
    int red = p[0] - base[0], green = p[1] - base[1], blue = p[2] - base[2];
    int sum = red + green + blue;
    int magnitude = sum < 0 ? -sum : sum;
    signed_sum[i] = sum;
    total_error += 3 * (red * red + green * green + blue * blue);
    total_magnitude += magnitude;
    if (magnitude > maximum)
      maximum = magnitude;
    // Each boundary is 3 times the midpoint of a modifier pair. Prefix
    // counts and sums evaluate eight palettes without 8×8 pixel searches.
    int bin;
    if (magnitude <= 82)
      bin = magnitude <= 33 ? (magnitude <= 15 ? 0 : 1)
                            : (magnitude <= 57 ? 2 : 3);
    else
      bin = magnitude <= 156 ? (magnitude <= 117 ? 4 : 5)
                             : (magnitude <= 208   ? 6
                                : magnitude <= 345 ? 7
                                                   : 8);
    counts[bin]++;
    sums[bin] += magnitude;
  }
  Palette best = {0, 0, 0x7fffffff};
  int count = 0, sum = 0;
  for (int table = 0; table < 8; table++) {
    count += counts[table];
    sum += sums[table];
    int a = 3 * luminance[table][0], b = 3 * luminance[table][1];
    int error = total_error + count * a * a + (8 - count) * b * b -
                2 * (sum * a + (total_magnitude - sum) * b);
    if (error < best.error) {
      best.error = error;
      best.table = table;
    }
    if (a >= maximum)
      break;
  }
  int threshold = 3 * (luminance[best.table][0] + luminance[best.table][1]);
  for (int i = 0; i < 8; i++) {
    int value = signed_sum[i], p = indices[i];
    int bit = (p % 4) * 4 + p / 4;
    int magnitude = value < 0 ? -value : value;
    best.selectors |= (u32)(2 * magnitude > threshold) << bit;
    best.selectors |= (u32)(value < 0) << (bit + 16);
  }
  return best;
}

static int fit_plane(const u8 pixels[16][3], u8 *out) {
  int codes[3][3], endpoints[3][3];
  for (int c = 0; c < 3; c++) {
    int sum = 0, dx = 0, dy = 0;
    for (int i = 0; i < 16; i++) {
      int value = pixels[i][c];
      sum += value;
      dx += (2 * (i % 4) - 3) * value;
      dy += (2 * (i / 4) - 3) * value;
    }
    // Least-squares plane on the centered 4×4 grid. ETC2's horizontal
    // and vertical endpoints lie one texel beyond the block's last row.
    float origin = sum / 16.f - 1.5f * (dx + dy) / 40.f;
    int bits = c == 1 ? 7 : 6, maximum = (1 << bits) - 1;
    for (int endpoint = 0; endpoint < 3; endpoint++) {
      float value = origin;
      if (endpoint == 1)
        value += dx / 10.f;
      if (endpoint == 2)
        value += dy / 10.f;
      int code = clamp((int)(value * (maximum / 255.f) + .5f), 0, maximum);
      codes[endpoint][c] = code;
      endpoints[endpoint][c] = (code << (8 - bits)) | (code >> (2 * bits - 8));
    }
  }
  int error = 0;
  for (int i = 0; i < 16; i++)
    for (int c = 0; c < 3; c++) {
      int origin = endpoints[0][c], horizontal = endpoints[1][c],
          vertical = endpoints[2][c];
      int value = (4 * origin + (horizontal - origin) * (i % 4) +
                   (vertical - origin) * (i / 4) + 2) >>
                  2;
      int residual = pixels[i][c] - clamp(value, 0, 255);
      error += residual * residual;
    }
  const int *o = codes[0], *h = codes[1], *v = codes[2];
  out[0] = (o[0] << 1) | (o[1] >> 6);
  out[1] = ((o[1] & 63) << 1) | (o[2] >> 5);
  out[2] = (o[2] & 24) | ((o[2] >> 1) & 3);
  out[3] = ((o[2] & 1) << 7) | ((h[0] & 62) << 1) | (h[0] & 1) | 2;
  out[4] = (h[1] << 1) | (h[2] >> 5);
  out[5] = ((h[2] & 31) << 3) | (v[0] >> 3);
  out[6] = ((v[0] & 7) << 5) | (v[1] >> 2);
  out[7] = ((v[1] & 3) << 6) | v[2];
  // The planar mode signal is an in-range red/green differential and an
  // out-of-range blue differential. These bits are free in planar mode.
  for (int c = 0; c < 2; c++)
    if ((out[c] >> 3) + (out[c] & 3) - ((out[c] & 4) ? 4 : 0) < 0)
      out[c] |= 128;
  out[2] |= (out[2] >> 3) + (out[2] & 3) < 4 ? 4 : 224;
  return error * 3;
}

static int encode_block(const u8 *source, int width, int height, int x, int y,
                        u8 *out) {
  u8 pixels[16][3];
  int sums[2][2][3] = {0};
  for (int i = 0; i < 16; i++) {
    int px = clamp(x + i % 4, 0, width - 1),
        py = clamp(y + i / 4, 0, height - 1);
    const u8 *p = source + 4 * (py * width + px);
    for (int c = 0; c < 3; c++) {
      pixels[i][c] = p[c];
      sums[0][(i % 4) / 2][c] += p[c];
      sums[1][i / 8][c] += p[c];
    }
  }
  int best = fit_plane(pixels, out);
  if (best <= 144)
    return best;
  // Select the axis explaining the greatest between-partition variance.
  int gain[2] = {0, 0};
  for (int direction = 0; direction < 2; direction++)
    for (int c = 0; c < 3; c++) {
      int d = sums[direction][0][c] - sums[direction][1][c];
      gain[direction] += d * d;
    }
  int flip = gain[1] > gain[0], differential = 1;
  int codes[3], base[2][3];
  for (int c = 0; c < 3; c++) {
    int a = (sums[flip][0][c] * 31 + 1020) / 2040,
        b = (sums[flip][1][c] * 31 + 1020) / 2040;
    if (b - a < -4 || b - a > 3) {
      differential = 0;
      break;
    }
    codes[c] = (a << 3) | ((b - a) & 7);
    base[0][c] = (a << 3) | (a >> 2);
    base[1][c] = (b << 3) | (b >> 2);
  }
  if (!differential)
    for (int c = 0; c < 3; c++) {
      int a = (sums[flip][0][c] * 15 + 1020) / 2040,
          b = (sums[flip][1][c] * 15 + 1020) / 2040;
      codes[c] = (a << 4) | b;
      base[0][c] = a * 17;
      base[1][c] = b * 17;
    }
  Palette a = fit_palette(pixels, partition_pixels[flip][0], base[0]);
  if (a.error >= best)
    return best;
  Palette b = fit_palette(pixels, partition_pixels[flip][1], base[1]);
  if (a.error + b.error >= best)
    return best;
  for (int c = 0; c < 3; c++)
    out[c] = codes[c];
  out[3] = (a.table << 5) | (b.table << 2) | (differential << 1) | flip;
  u32 selectors = a.selectors | b.selectors;
  for (int j = 0; j < 4; j++)
    out[4 + j] = (u8)(selectors >> (24 - j * 8));
  return a.error + b.error;
}

static float page_mse;
__attribute__((visibility("default"))) float mean_squared_error(void) {
  return page_mse;
}

__attribute__((visibility("default"))) int
encode(u8 *source, int width, int height, u8 *out, int mipmaps) {
  if (width < 1 || width > 512 || height < 1 || height > 512)
    return 0;
  int total = 0, first = 1;
  for (;;) {
    double squared = 0;
    for (int y = 0; y < height; y += 4)
      for (int x = 0; x < width; x += 4) {
        squared += encode_block(source, width, height, x, y, out + total);
        total += 8;
      }
    if (first) {
      page_mse = squared / (9.0 * width * height);
      first = 0;
    }
    if (!mipmaps || (width == 1 && height == 1))
      return total;
    int w = width > 1 ? width / 2 : 1, h = height > 1 ? height / 2 : 1;
    for (int y = 0; y < h; y++)
      for (int x = 0; x < w; x++)
        for (int c = 0; c < 4; c++) {
          int a = (2 * y * width + 2 * x) * 4 + c, b = a + (width > 1 ? 4 : 0);
          int next = height > 1 ? width * 4 : 0;
          source[(y * w + x) * 4 + c] =
              (source[a] + source[b] + source[a + next] + source[b + next] +
               2) /
              4;
        }
    width = w;
    height = h;
  }
}

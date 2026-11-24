typedef unsigned char u8;
typedef unsigned int u32;
static const int weight[16] = {0,  4,  9,  13, 17, 21, 26, 30,
                               34, 38, 43, 47, 51, 55, 60, 64};
static int bound(int x, int low, int high) {
  return x < low ? low : x > high ? high : x;
}
static void emit(u32 *out, int *bit, int v, int n) {
  int o = *bit / 32, s = *bit % 32;
  out[o] |= (u32)v << s;
  if (s + n > 32)
    out[o + 1] |= (u32)v >> (32 - s);
  *bit += n;
}
static int assign(const float rgb[16][3], float end[2][3], u8 *indices) {
  float dir[3], len = 0;
  for (int k = 0; k < 3; k++) {
    dir[k] = end[1][k] - end[0][k];
    len += dir[k] * dir[k];
  }
  if (len < .0001f) {
    for (int i = 0; i < 16; i++)
      indices[i] = 0;
    return 0;
  }
  for (int i = 0; i < 16; i++) {
    float p = 0;
    for (int k = 0; k < 3; k++)
      p += (rgb[i][k] - end[0][k]) * dir[k];
    indices[i] = bound((int)(p * 15 / len + .5f), 0, 15);
  }
  return 1;
}
static void block(const u8 *src, int width, int height, int x, int y,
                  u32 *out) {
  float rgb[16][3], avg[3] = {0}, cov[3][3] = {0}, dir[3] = {.25f, .6f, .15f},
                    end[2][3];
  for (int i = 0; i < 16; i++) {
    int at = 4 * (bound(y + i / 4, 0, height - 1) * width +
                  bound(x + i % 4, 0, width - 1));
    for (int k = 0; k < 3; k++) {
      rgb[i][k] = src[at + k];
      avg[k] += rgb[i][k] * (1.f / 16.f);
    }
  }
  for (int i = 0; i < 16; i++)
    for (int k = 0; k < 3; k++)
      for (int l = 0; l < 3; l++)
        cov[k][l] += (rgb[i][k] - avg[k]) * (rgb[i][l] - avg[l]);
  for (int n = 0; n < 3; n++) {
    float a[3] = {0};
    for (int k = 0; k < 3; k++)
      for (int l = 0; l < 3; l++)
        a[k] += dir[l] * cov[k][l];
    float scale = 1.f / (.001f + __builtin_fabsf(a[0]) + __builtin_fabsf(a[1]) +
                         __builtin_fabsf(a[2]));
    for (int k = 0; k < 3; k++)
      dir[k] = a[k] * scale;
  }
  int imin = 0, imax = 0;
  float lo = 1e12f, hi = -1e12f;
  for (int i = 0; i < 16; i++) {
    float v = 0;
    for (int k = 0; k < 3; k++)
      v += dir[k] * rgb[i][k];
    if (v < lo) {
      lo = v;
      imin = i;
    }
    if (v > hi) {
      hi = v;
      imax = i;
    }
  }
  for (int k = 0; k < 3; k++) {
    end[0][k] = rgb[imin][k];
    end[1][k] = rgb[imax][k];
  }
  u8 idx[16];
  if (assign(rgb, end, idx)) {
    float aa = 0, ab = 0, bb = 0, rhs0[3] = {0}, rhs1[3] = {0};
    for (int i = 0; i < 16; i++) {
      float b = weight[idx[i]] * (1.f / 64.f), a = 1.f - b;
      aa += a * a;
      ab += a * b;
      bb += b * b;
      for (int k = 0; k < 3; k++) {
        rhs0[k] += a * rgb[i][k];
        rhs1[k] += b * rgb[i][k];
      }
    }
    float det = aa * bb - ab * ab;
    if (det > 1e-5f)
      for (int k = 0; k < 3; k++) {
        end[0][k] = (rhs0[k] * bb - rhs1[k] * ab) / det;
        end[1][k] = (rhs1[k] * aa - rhs0[k] * ab) / det;
      }
  }
  for (int e = 0; e < 2; e++)
    for (int k = 0; k < 3; k++)
      end[e][k] = bound((int)(end[e][k] * .5f), 0, 127) * 2 + 1;
  assign(rgb, end, idx);
  int reverse = idx[0] >= 8;
  int bit = 0;
  for (int i = 0; i < 4; i++)
    out[i] = 0;
  emit(out, &bit, 64, 7);
  for (int k = 0; k < 4; k++)
    for (int i = 0; i < 2; i++)
      emit(out, &bit, k == 3 ? 127 : ((int)end[i ^ reverse][k]) / 2, 7);
  emit(out, &bit, 3, 2);
  for (int i = 0; i < 16; i++)
    emit(out, &bit, reverse ? 15 - idx[i] : idx[i], i == 0 ? 3 : 4);
}
__attribute__((visibility("default"))) int
encode(u8 *src, int width, int height, u8 *dst, int mip) {
  int total = 0;
  for (;;) {
    for (int y = 0; y < height; y += 4)
      for (int x = 0; x < width; x += 4) {
        block(src, width, height, x, y, (u32 *)(dst + total));
        total += 16;
      }
    if (!mip || (width == 1 && height == 1))
      return total;
    int w = width > 1 ? width / 2 : 1, h = height > 1 ? height / 2 : 1;
    for (int y = 0; y < h; y++)
      for (int x = 0; x < w; x++)
        for (int k = 0; k < 4; k++) {
          int a = (y * 2 * width + x * 2) * 4 + k, b = a + (width > 1 ? 4 : 0),
              c = a + (height > 1 ? 4 * width : 0),
              d = b + (height > 1 ? 4 * width : 0);
          src[(y * w + x) * 4 + k] =
              (src[a] + src[b] + src[c] + src[d] + 2) / 4;
        }
    width = w;
    height = h;
  }
}

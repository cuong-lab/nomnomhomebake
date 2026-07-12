// Nén ảnh phía trình duyệt TRƯỚC khi upload lên Supabase Storage.
// Ảnh gốc từ điện thoại thường 3-5MB → nén về vài trăm KB (WebP) giúp trang tải
// nhanh hơn nhiều trên 4G mà mắt thường gần như không thấy khác biệt.

const SKIP_UNDER_BYTES = 300 * 1024; // ảnh đã nhỏ (<300KB) thì khỏi nén

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

export async function compressImage(file, { maxDim = 1200, quality = 0.74 } = {}) {
  // Không đụng tới: file rỗng, không phải ảnh, GIF (giữ animation), ảnh đã nhỏ sẵn.
  if (!file || !file.type || !file.type.startsWith("image/")) return file;
  if (file.type === "image/gif") return file;
  if (file.size <= SKIP_UNDER_BYTES) return file;

  try {
    const img = await loadImage(file);
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);

    // Ưu tiên WebP (nhẹ hơn ~30% JPEG); nếu trình duyệt không hỗ trợ thì fallback JPEG.
    let type = "image/webp";
    let ext = "webp";
    const testWebp = canvas.toDataURL("image/webp");
    if (!testWebp.startsWith("data:image/webp")) {
      type = "image/jpeg";
      ext = "jpg";
    }

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, quality));
    // Nếu vì lý do nào đó nén xong lại to hơn bản gốc thì giữ bản gốc.
    if (!blob || blob.size >= file.size) return file;

    const baseName = (file.name || "image").replace(/\.[^./\\]+$/, "");
    return new File([blob], `${baseName}.${ext}`, { type });
  } catch (e) {
    // Nén lỗi thì cứ dùng file gốc, không chặn việc upload.
    return file;
  }
}

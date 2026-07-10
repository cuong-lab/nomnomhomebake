// ── Reviews ──
// Danh sách đánh giá của khách + điểm trung bình (social proof ở hero và đầu mục).
// Export:
//   - initReviews(): gắn sự kiện (chọn sao, gửi form) rồi tải lần đầu.
//   - loadReviews():  tải lại + render (auth handler gọi khi đổi trạng thái admin).

import { supabase } from "../supabase.js";
import { compressImage } from "../shared/imageUtils.js";
import { state } from "../store.js";

const reviewList = document.getElementById("review-list");
const reviewForm = document.getElementById("review-form");
const reviewError = document.getElementById("review-error");
const starPicker = document.getElementById("star-picker");
let selectedRating = 5;

function renderStars(n) {
  return "★".repeat(n) + "☆".repeat(5 - n);
}

// Điểm trung bình + số lượng để làm social proof ở hero và đầu mục Reviews.
function reviewSummary(reviews) {
  const rated = reviews.filter((r) => Number(r.rating) > 0);
  if (!rated.length) return { avg: 0, count: 0 };
  const avg = rated.reduce((sum, r) => sum + Number(r.rating), 0) / rated.length;
  return { avg, count: rated.length };
}

function renderReviewSummary(reviews) {
  const { avg, count } = reviewSummary(reviews);
  const heroBox = document.getElementById("hero-social-proof");
  const summaryBox = document.getElementById("review-summary");
  if (!count) {
    heroBox?.classList.add("hidden");
    heroBox?.classList.remove("inline-flex");
    summaryBox?.classList.add("hidden");
    summaryBox?.classList.remove("flex");
    return;
  }
  const avgText = avg.toFixed(1);
  const rounded = Math.round(avg);

  if (heroBox) {
    document.getElementById("hero-rating-value").textContent = avgText;
    document.getElementById("hero-rating-count").textContent = count;
    heroBox.classList.remove("hidden");
    heroBox.classList.add("inline-flex");
  }
  if (summaryBox) {
    document.getElementById("review-summary-avg").textContent = avgText;
    document.getElementById("review-summary-stars").textContent = renderStars(rounded);
    document.getElementById("review-summary-count").textContent = `${count} đánh giá`;
    summaryBox.classList.remove("hidden");
    summaryBox.classList.add("flex");
  }
}

function formatReviewDate(iso) {
  const d = new Date(iso);
  const now = new Date();
  const diffDays = Math.floor((now - d) / 86400000);
  if (diffDays === 0) return "Hôm nay";
  if (diffDays === 1) return "Hôm qua";
  if (diffDays < 7) return `${diffDays} ngày trước`;
  return d.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function renderReviews(reviews) {
  renderReviewSummary(reviews);
  if (!reviews.length) {
    reviewList.innerHTML = `<p class="text-sm text-ash">Chưa có đánh giá nào. Hãy là người đầu tiên!</p>`;
    return;
  }

  reviewList.innerHTML = reviews
    .map(
      (r) => `
    <div class="w-[280px] shrink-0 snap-start border border-earth/40 p-5 md:w-[320px] ${state.isAdmin ? "group relative" : ""}">
      ${r.image_url ? `<img src="${r.image_url}" alt="Ảnh đánh giá" loading="lazy" decoding="async" class="mb-4 h-40 w-full rounded object-cover" />` : ""}
      <div class="flex items-center gap-2">
        <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-earth/30 font-serif text-sm text-ink">
          ${r.name.charAt(0).toUpperCase()}
        </div>
        <div class="min-w-0">
          <span class="block text-sm font-medium text-ink leading-tight">${r.name}</span>
          ${r.created_at ? `<span class="block text-[11px] text-ash">${formatReviewDate(r.created_at)}</span>` : ""}
        </div>
      </div>
      <div class="mt-2 text-sm text-[#f39c12]">${renderStars(r.rating)}</div>
      <p class="mt-2 text-sm text-ash line-clamp-3">${r.comment}</p>
      ${state.isAdmin ? `<button data-delete-review="${r.id}" class="absolute top-2 right-2 text-xs text-red-500 hover:text-red-700 opacity-0 group-hover:opacity-100 transition-opacity">✕</button>` : ""}
    </div>
  `
    )
    .join("");

  if (state.isAdmin) {
    reviewList.querySelectorAll("[data-delete-review]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        await supabase.from("reviews").delete().eq("id", btn.dataset.deleteReview);
        loadReviews();
      })
    );
  }
}

export async function loadReviews() {
  const { data } = await supabase
    .from("reviews")
    .select("*")
    .order("created_at", { ascending: false });

  renderReviews(data || []);
}

export function initReviews() {
  starPicker.querySelectorAll("[data-star]").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedRating = parseInt(btn.dataset.star);
      reviewForm.elements.rating.value = selectedRating;
      starPicker.querySelectorAll("[data-star]").forEach((b, i) => {
        b.classList.toggle("text-[#f39c12]", i < selectedRating);
        b.classList.toggle("text-earth/50", i >= selectedRating);
      });
    });
  });

  reviewForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = new FormData(reviewForm);
    const imageFile = reviewForm.elements.image.files[0];

    let image_url = null;

    if (imageFile) {
      const reviewC = await compressImage(imageFile);
      const ext = reviewC.name.split(".").pop();
      const fileName = `review-${Date.now()}.${ext}`;
      const { error: uploadError } = await supabase.storage
        .from("product-images")
        .upload(fileName, reviewC);

      if (uploadError) {
        reviewError.textContent = "Lỗi upload ảnh: " + uploadError.message;
        reviewError.classList.remove("hidden");
        return;
      }

      const { data: urlData } = supabase.storage.from("product-images").getPublicUrl(fileName);
      image_url = urlData.publicUrl;
    }

    const row = {
      name: form.get("name"),
      rating: parseInt(form.get("rating")),
      comment: form.get("comment"),
    };
    if (image_url) row.image_url = image_url;

    const { error } = await supabase.from("reviews").insert(row);

    if (error) {
      reviewError.textContent = "Lỗi gửi đánh giá: " + error.message;
      reviewError.classList.remove("hidden");
      return;
    }

    reviewError.classList.add("hidden");
    reviewForm.reset();
    selectedRating = 5;
    starPicker.querySelectorAll("[data-star]").forEach((b) => b.classList.replace("text-earth/50", "text-[#f39c12]"));
    loadReviews();
  });

  loadReviews();
}

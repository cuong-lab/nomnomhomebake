// ── Banner Slideshow (+ quản lý banner cho admin) ──
// Export:
//   - initBanner():  gắn sự kiện (dots, modal quản lý) rồi tải lần đầu.
//   - loadBanners(): tải lại banner (auth handler gọi khi đổi trạng thái admin).

import { supabase } from "../supabase.js";
import { compressImage } from "../shared/imageUtils.js";
import { state } from "../store.js";

const bannerSlides = document.getElementById("banner-slides");
const bannerDots = document.getElementById("banner-dots");
const bannerEditBtn = document.getElementById("banner-edit-btn");
const bannerSection = document.getElementById("banner-section");
let bannerIndex = 0;
let bannerCount = 0;
let bannerTimer = null;

function goToBanner(i) {
  bannerIndex = ((i % bannerCount) + bannerCount) % bannerCount;
  bannerSlides.style.transform = `translateX(-${bannerIndex * 100}%)`;
  bannerDots.querySelectorAll("button").forEach((dot, idx) => {
    dot.classList.toggle("bg-ink", idx === bannerIndex);
    dot.classList.toggle("bg-ink/30", idx !== bannerIndex);
  });
}

function startBannerAutoplay() {
  if (bannerTimer) clearInterval(bannerTimer);
  if (bannerCount > 1) {
    bannerTimer = setInterval(() => goToBanner(bannerIndex + 1), 10000);
  }
}

export async function loadBanners() {
  const { data, error } = await supabase
    .from("banners")
    .select("*")
    .order("sort_order", { ascending: true });

  if (error) {
    bannerSection.classList.add("hidden");
    return;
  }

  const slides = data || [];
  bannerCount = slides.length;

  bannerEditBtn.classList.toggle("hidden", !state.isAdmin);

  if (!slides.length) {
    if (state.isAdmin) {
      bannerSection.classList.remove("hidden");
      bannerSlides.innerHTML = `<div class="flex h-[120px] w-full shrink-0 items-center justify-center md:h-[200px]"><span class="text-sm italic text-ash">Chưa có banner</span></div>`;
    } else {
      bannerSection.classList.add("hidden");
    }
    if (bannerTimer) clearInterval(bannerTimer);
    return;
  }

  bannerSection.classList.remove("hidden");
  bannerSlides.innerHTML = slides
    .map((s) => `<div class="h-[120px] w-full shrink-0 md:h-[200px]"><img src="${s.image_url}" alt="" class="h-full w-full object-cover" /></div>`)
    .join("");

  if (slides.length > 1) {
    bannerDots.classList.remove("hidden");
    bannerDots.innerHTML = slides
      .map((_, i) => `<button class="h-2 w-2 rounded-full ${i === 0 ? "bg-ink" : "bg-ink/30"} transition-colors" aria-label="Banner ${i + 1}"></button>`)
      .join("");
    bannerDots.querySelectorAll("button").forEach((dot, i) =>
      dot.addEventListener("click", () => { goToBanner(i); startBannerAutoplay(); })
    );
    startBannerAutoplay();
  } else {
    bannerDots.classList.add("hidden");
  }

  bannerIndex = 0;
  bannerSlides.style.transform = "translateX(0)";
}

// ── Banner Admin ──

const bannerModal = document.getElementById("banner-modal");
const bannerList = document.getElementById("banner-list");
const bannerUpload = document.getElementById("banner-upload");

async function renderBannerList() {
  const { data } = await supabase.from("banners").select("*").order("sort_order");
  const items = data || [];

  if (!items.length) {
    bannerList.innerHTML = `<p class="text-sm text-ash">Chưa có banner nào.</p>`;
    return;
  }

  bannerList.innerHTML = items
    .map(
      (s) => `
    <div class="flex items-center gap-3 border border-earth/40 p-2">
      <img src="${s.image_url}" alt="" class="h-12 w-20 object-cover shrink-0" />
      <span class="text-sm text-ash flex-1 truncate">${s.image_url.split("/").pop()}</span>
      <button data-delete-banner="${s.id}" class="text-xs text-red-500 hover:text-red-700 shrink-0">Xóa</button>
    </div>
  `
    )
    .join("");

  bannerList.querySelectorAll("[data-delete-banner]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await supabase.from("banners").delete().eq("id", btn.dataset.deleteBanner);
      await renderBannerList();
      loadBanners();
    })
  );
}

export function initBanner() {
  bannerEditBtn.addEventListener("click", () => {
    bannerModal.classList.remove("hidden");
    bannerModal.classList.add("flex");
    renderBannerList();
  });

  document.getElementById("banner-close").addEventListener("click", () => {
    bannerModal.classList.add("hidden");
    bannerModal.classList.remove("flex");
  });

  bannerModal.addEventListener("click", (e) => {
    if (e.target === bannerModal) {
      bannerModal.classList.add("hidden");
      bannerModal.classList.remove("flex");
    }
  });

  bannerUpload.addEventListener("change", async () => {
    let file = bannerUpload.files[0];
    if (!file) return;
    file = await compressImage(file);

    const ext = file.name.split(".").pop();
    const fileName = `banner-${Date.now()}.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from("product-images")
      .upload(fileName, file);

    if (uploadError) {
      alert("Lỗi upload: " + uploadError.message);
      return;
    }

    const { data: urlData } = supabase.storage.from("product-images").getPublicUrl(fileName);

    const { data: existing } = await supabase.from("banners").select("sort_order").order("sort_order", { ascending: false }).limit(1);
    const nextOrder = existing?.length ? existing[0].sort_order + 1 : 0;

    await supabase.from("banners").insert({ image_url: urlData.publicUrl, sort_order: nextOrder });

    bannerUpload.value = "";
    await renderBannerList();
    loadBanners();
  });

  loadBanners();
}

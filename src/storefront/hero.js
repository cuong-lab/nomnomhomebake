// ── Hero Slideshow (+ quản lý ảnh hero cho admin) ──
// Export:
//   - initHero():      gắn sự kiện (mũi tên, dots, modal quản lý ảnh) rồi tải lần đầu.
//   - loadHeroSlides(): tải lại slideshow (auth handler gọi khi đổi trạng thái admin).

import { supabase } from "../supabase.js";
import { compressImage } from "../shared/imageUtils.js";
import { state } from "../store.js";

const heroSlides = document.getElementById("hero-slides");
const heroEditBtn = document.getElementById("hero-edit-btn");
const heroPrev = document.getElementById("hero-prev");
const heroNext = document.getElementById("hero-next");
const heroDots = document.getElementById("hero-dots");
const heroSlideshow = document.getElementById("hero-slideshow");
let currentSlide = 0;
let slideCount = 0;
let autoplayTimer = null;

function goToSlide(i) {
  currentSlide = ((i % slideCount) + slideCount) % slideCount;
  heroSlides.style.transform = `translateX(-${currentSlide * 100}%)`;
  heroDots.querySelectorAll("button").forEach((dot, idx) => {
    dot.classList.toggle("bg-ink", idx === currentSlide);
    dot.classList.toggle("bg-ink/30", idx !== currentSlide);
  });
}

function startAutoplay() {
  stopAutoplay();
  if (slideCount > 1) {
    autoplayTimer = setInterval(() => goToSlide(currentSlide + 1), 4000);
  }
}

function stopAutoplay() {
  if (autoplayTimer) clearInterval(autoplayTimer);
}

export async function loadHeroSlides() {
  const { data } = await supabase
    .from("hero_slides")
    .select("*")
    .order("sort_order", { ascending: true });

  const slides = data || [];
  slideCount = slides.length;

  heroEditBtn.classList.toggle("hidden", !state.isAdmin);

  if (!slides.length) {
    heroSlides.innerHTML = `<div class="flex h-full w-full shrink-0 items-center justify-center"><span class="font-serif text-xl italic text-ash">Ảnh sản phẩm</span></div>`;
    heroPrev.classList.add("hidden");
    heroNext.classList.add("hidden");
    heroDots.classList.add("hidden");
    stopAutoplay();
    return;
  }

  heroSlides.innerHTML = slides
    .map((s) => `<div class="h-full w-full shrink-0"><img src="${s.image_url}" alt="" class="h-full w-full object-cover transition-transform duration-500 hover:scale-[1.2]" /></div>`)
    .join("");

  if (slides.length > 1) {
    heroPrev.classList.remove("hidden");
    heroNext.classList.remove("hidden");
    heroDots.classList.remove("hidden");
    heroSlideshow.addEventListener("mouseenter", () => {
      heroPrev.style.opacity = "1";
      heroNext.style.opacity = "1";
    });
    heroSlideshow.addEventListener("mouseleave", () => {
      heroPrev.style.opacity = "0";
      heroNext.style.opacity = "0";
    });
    heroDots.innerHTML = slides
      .map((_, i) => `<button class="h-2 w-2 rounded-full ${i === 0 ? "bg-ink" : "bg-ink/30"} transition-colors" aria-label="Slide ${i + 1}"></button>`)
      .join("");
    heroDots.querySelectorAll("button").forEach((dot, i) =>
      dot.addEventListener("click", () => { goToSlide(i); startAutoplay(); })
    );
    startAutoplay();
  } else {
    heroPrev.classList.add("hidden");
    heroNext.classList.add("hidden");
    heroDots.classList.add("hidden");
  }

  currentSlide = 0;
  heroSlides.style.transform = "translateX(0)";
}

// ── Hero Slides Admin ──

const slidesModal = document.getElementById("slides-modal");
const slidesList = document.getElementById("slides-list");
const slideUpload = document.getElementById("slide-upload");

async function openSlidesModal() {
  slidesModal.classList.remove("hidden");
  slidesModal.classList.add("flex");
  await renderSlidesList();
}

function closeSlidesModal() {
  slidesModal.classList.add("hidden");
  slidesModal.classList.remove("flex");
}

async function renderSlidesList() {
  const { data } = await supabase.from("hero_slides").select("*").order("sort_order");
  const slides = data || [];

  if (!slides.length) {
    slidesList.innerHTML = `<p class="text-sm text-ash">Chưa có ảnh nào.</p>`;
    return;
  }

  slidesList.innerHTML = slides
    .map(
      (s) => `
    <div class="flex items-center gap-3 border border-earth/40 p-2">
      <img src="${s.image_url}" alt="" class="h-16 w-16 object-cover shrink-0" />
      <span class="text-sm text-ash flex-1 truncate">${s.image_url.split("/").pop()}</span>
      <button data-delete-slide="${s.id}" class="text-xs text-red-500 hover:text-red-700 shrink-0">Xóa</button>
    </div>
  `
    )
    .join("");

  slidesList.querySelectorAll("[data-delete-slide]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await supabase.from("hero_slides").delete().eq("id", btn.dataset.deleteSlide);
      await renderSlidesList();
      loadHeroSlides();
    })
  );
}

export function initHero() {
  heroPrev.addEventListener("click", () => { goToSlide(currentSlide - 1); startAutoplay(); });
  heroNext.addEventListener("click", () => { goToSlide(currentSlide + 1); startAutoplay(); });

  heroEditBtn.addEventListener("click", openSlidesModal);
  document.getElementById("slides-close").addEventListener("click", closeSlidesModal);
  slidesModal.addEventListener("click", (e) => { if (e.target === slidesModal) closeSlidesModal(); });

  slideUpload.addEventListener("change", async () => {
    let file = slideUpload.files[0];
    if (!file) return;
    file = await compressImage(file);

    const ext = file.name.split(".").pop();
    const fileName = `hero-${Date.now()}.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from("product-images")
      .upload(fileName, file);

    if (uploadError) {
      alert("Lỗi upload: " + uploadError.message);
      return;
    }

    const { data: urlData } = supabase.storage.from("product-images").getPublicUrl(fileName);

    const { data: existing } = await supabase.from("hero_slides").select("sort_order").order("sort_order", { ascending: false }).limit(1);
    const nextOrder = existing?.length ? existing[0].sort_order + 1 : 0;

    await supabase.from("hero_slides").insert({ image_url: urlData.publicUrl, sort_order: nextOrder });

    slideUpload.value = "";
    await renderSlidesList();
    loadHeroSlides();
  });

  loadHeroSlides();
}

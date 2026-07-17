document.addEventListener('DOMContentLoaded', () => {
    const menuToggle = document.getElementById('menuToggle');
    const mobileMenu = document.getElementById('mobileMenu');

    if (menuToggle && mobileMenu) {
        menuToggle.addEventListener('click', () => {
            const isExpanded = menuToggle.getAttribute('aria-expanded') === 'true' || false;
            menuToggle.setAttribute('aria-expanded', !isExpanded);
            menuToggle.classList.toggle('open');
            mobileMenu.classList.toggle('open');
            
            // Toggle aria-hidden on mobile menu
            mobileMenu.setAttribute('aria-hidden', isExpanded);
        });
    }
});

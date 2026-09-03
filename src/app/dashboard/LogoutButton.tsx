'use client';

export default function LogoutButton() {
  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/auth/login';
  }
  return (
    <button
      onClick={handleLogout}
      className="text-sm text-gray-500 hover:text-gray-800"
    >
      Sign out
    </button>
  );
}

import { Routes, Route, Navigate } from 'react-router-dom'

function App() {
  return (
    <div className="min-h-screen bg-gray-50">
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/files/*" element={<FileBrowserLayout />} />
        <Route path="/" element={<Navigate to="/files" replace />} />
      </Routes>
    </div>
  )
}

function LoginPage() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="max-w-md w-full mx-auto p-6">
        <div className="bg-white rounded-lg shadow-md p-8">
          <h1 className="text-2xl font-bold text-center mb-6">HomeCloud</h1>
          <h2 className="text-xl font-semibold mb-4">Sign In</h2>
          <form className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">Email</label>
              <input type="email" className="w-full border rounded-md px-3 py-2" />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Password</label>
              <input type="password" className="w-full border rounded-md px-3 py-2" />
            </div>
            <button type="submit" className="w-full bg-blue-600 text-white rounded-md py-2 hover:bg-blue-700">
              Sign In
            </button>
          </form>
          <p className="mt-4 text-center text-sm">
            Don't have an account? <a href="/register" className="text-blue-600">Register</a>
          </p>
        </div>
      </div>
    </div>
  )
}

function RegisterPage() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="max-w-md w-full mx-auto p-6">
        <div className="bg-white rounded-lg shadow-md p-8">
          <h1 className="text-2xl font-bold text-center mb-6">HomeCloud</h1>
          <h2 className="text-xl font-semibold mb-4">Create Account</h2>
          <form className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">Email</label>
              <input type="email" className="w-full border rounded-md px-3 py-2" />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Password</label>
              <input type="password" className="w-full border rounded-md px-3 py-2" />
            </div>
            <button type="submit" className="w-full bg-blue-600 text-white rounded-md py-2 hover:bg-blue-700">
              Register
            </button>
          </form>
          <p className="mt-4 text-center text-sm">
            Already have an account? <a href="/login" className="text-blue-600">Sign In</a>
          </p>
        </div>
      </div>
    </div>
  )
}

function FileBrowserLayout() {
  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Routes>
          <Route path="/" element={<FileBrowser />} />
        </Routes>
      </main>
    </div>
  )
}

function Navbar() {
  return (
    <nav className="bg-white shadow-sm border-b">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between h-16 items-center">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-gray-900">HomeCloud</h1>
          </div>
          <div className="flex items-center gap-4">
            <button className="text-gray-700 hover:text-gray-900">Logout</button>
          </div>
        </div>
      </div>
    </nav>
  )
}

function FileBrowser() {
  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900">My Files</h2>
      </div>
      <div className="bg-white rounded-lg shadow-sm border-2 border-dashed border-gray-300 p-8 text-center">
        <div className="flex flex-col items-center justify-center">
          <svg className="w-12 h-12 text-gray-400 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
          </svg>
          <p className="text-lg font-medium text-gray-700 mb-2">Drag and drop files here</p>
          <p className="text-sm text-gray-500">or click to browse</p>
        </div>
      </div>
      <div className="mt-6">
        <p className="text-gray-500 text-center">File list placeholder - integration pending</p>
      </div>
    </div>
  )
}

export default App

<template>
  <div class="shell" :style="{ backgroundImage: `url('${backgroundImageUrl}')` }">
    <main v-if="authLoading" class="auth-panel">
      <h1>FlareDrive</h1>
      <p>正在连接...</p>
    </main>

    <main v-else-if="!user" class="auth-panel">
      <h1>FlareDrive</h1>
      <form @submit.prevent="submitAuth">
        <label>
          <span>账号</span>
          <input v-model.trim="authForm.username" autocomplete="username" required />
        </label>
        <label>
          <span>密码</span>
          <input
            v-model="authForm.password"
            :autocomplete="authMode === 'login' ? 'current-password' : 'new-password'"
            type="password"
            minlength="8"
            required
          />
        </label>
        <button class="primary" type="submit">
          {{ authMode === "login" ? "登录" : "注册" }}
        </button>
      </form>
      <button class="link-button" type="button" @click="toggleAuthMode">
        {{ authMode === "login" ? "注册第一个账号" : "已有账号，去登录" }}
      </button>
      <p v-if="message" class="message">{{ message }}</p>
    </main>

    <template v-else>
      <progress v-if="uploadProgress !== null" :value="uploadProgress" max="100"></progress>

      <header class="topbar">
        <a class="brand" href="/">
          <img src="/assets/homescreen.png" alt="FlareDrive" />
          <span>FlareDrive</span>
        </a>
        <input v-model="search" type="search" placeholder="搜索文件" />
        <button type="button" @click="showPastes = !showPastes">文字暂存</button>
        <button type="button" @click="showShares = !showShares">分享管理</button>
        <button type="button" @click="logout">退出</button>
      </header>

      <section class="workspace">
        <aside class="sidebar">
          <div>
            <strong>{{ user.username }}</strong>
            <span>{{ user.role === "admin" ? "管理员" : "普通用户" }}</span>
          </div>
          <button type="button" @click="$refs.fileInput.click()">上传文件</button>
          <button type="button" @click="createFolder">新建文件夹</button>
          <button type="button" @click="refresh">刷新</button>
          <input ref="fileInput" type="file" multiple hidden @change="onUploadPicked" />
        </aside>

        <section class="file-panel">
          <div class="pathbar">
            <button v-if="canGoUp" type="button" @click="goUp">上一级</button>
            <span>{{ displayPath }}</span>
          </div>

          <ul class="file-list">
            <li v-for="folder in filteredFolders" :key="folder" class="file-row">
              <button class="file-main" type="button" @click="cwd = folder">
                <span class="file-icon">目录</span>
                <span>{{ folderName(folder) }}</span>
              </button>
              <button type="button" @click="copyText(folderLink(folder))">复制链接</button>
              <button class="danger" type="button" @click="removeFile(folder + '_$folder$')">删除</button>
            </li>

            <li v-for="file in filteredFiles" :key="file.key" class="file-row">
              <button class="file-main" type="button" @click="preview(file.key)">
                <span class="file-icon">文件</span>
                <span>
                  <strong>{{ fileName(file.key) }}</strong>
                  <small>{{ formatSize(file.size) }} · {{ formatDate(file.uploaded) }}</small>
                </span>
              </button>
              <a :href="`/raw/${file.key}`" download>下载</a>
              <button type="button" @click="shareFile(file.key)">分享</button>
              <button class="danger" type="button" @click="removeFile(file.key)">删除</button>
            </li>
          </ul>

          <div v-if="loading" class="empty">加载中...</div>
          <div v-else-if="!filteredFiles.length && !filteredFolders.length" class="empty">没有文件</div>
        </section>
      </section>

      <section v-if="showPastes" class="paste-panel">
        <div class="paste-header">
          <h2>文字暂存</h2>
          <button type="button" @click="newPaste">新建</button>
        </div>
        <div class="paste-grid">
          <ul class="paste-list">
            <li v-for="paste in pastes" :key="paste.id">
              <button type="button" @click="editPaste(paste.id)">
                <strong>{{ paste.title }}</strong>
                <small>{{ paste.preview }}</small>
              </button>
              <button type="button" @click="sharePaste(paste.id)">分享</button>
              <button class="danger" type="button" @click="deletePaste(paste.id)">删除</button>
            </li>
          </ul>
          <form class="paste-editor" @submit.prevent="savePaste">
            <input v-model="pasteEditor.title" placeholder="标题" />
            <textarea v-model="pasteEditor.content" placeholder="临时文字"></textarea>
            <button class="primary" type="submit">保存</button>
          </form>
        </div>
      </section>

      <section v-if="showShares" class="share-panel">
        <div class="paste-header">
          <h2>分享管理</h2>
          <button type="button" @click="loadShares">刷新</button>
        </div>
        <ul class="share-list">
          <li v-for="share in shares" :key="share.token" class="share-row">
            <div>
              <strong>{{ share.token }}</strong>
              <small>{{ shareLabel(share) }} · {{ formatDate(share.created_at * 1000) }}</small>
            </div>
            <button type="button" @click="copyText(shareUrl(share))">复制</button>
            <a :href="shareUrl(share)" target="_blank">打开</a>
            <button class="danger" type="button" @click="deleteShare(share.token)">删除</button>
          </li>
        </ul>
        <div v-if="!shares.length" class="empty">还没有分享链接</div>
      </section>

      <div v-if="message" class="toast">{{ message }}</div>
    </template>
  </div>
</template>

<script>
import {
  generateThumbnail,
  blobDigest,
  multipartUpload,
  singleUpload,
  SIZE_LIMIT,
  writeItemUrl,
} from "/assets/main.mjs?v=20260704-share2";

export default {
  data: () => ({
    authLoading: true,
    authMode: "login",
    authForm: { username: "", password: "" },
    user: null,
    cwd: new URL(window.location).searchParams.get("p") || "",
    files: [],
    folders: [],
    loading: false,
    search: "",
    showPastes: false,
    showShares: false,
    pastes: [],
    shares: [],
    pasteEditor: { id: null, title: "", content: "" },
    uploadProgress: null,
    uploadQueue: [],
    message: "",
    backgroundImageUrl: "/assets/bg-light.webp",
  }),

  computed: {
    canGoUp() {
      return this.cwd && this.cwd !== this.user?.homePrefix;
    },
    displayPath() {
      return this.cwd || "/";
    },
    filteredFiles() {
      if (!this.search) return this.files;
      return this.files.filter((file) =>
        this.fileName(file.key).toLowerCase().includes(this.search.toLowerCase())
      );
    },
    filteredFolders() {
      if (!this.search) return this.folders;
      return this.folders.filter((folder) =>
        this.folderName(folder).toLowerCase().includes(this.search.toLowerCase())
      );
    },
  },

  watch: {
    cwd(value) {
      if (!this.user) return;
      this.fetchFiles();
      const url = new URL(window.location);
      value ? url.searchParams.set("p", value) : url.searchParams.delete("p");
      window.history.pushState(null, "", url.toString());
    },
    showPastes(value) {
      if (value) this.loadPastes();
    },
    showShares(value) {
      if (value) this.loadShares();
    },
  },

  async created() {
    await this.loadMe();
    window.addEventListener("popstate", () => {
      this.cwd = new URL(window.location).searchParams.get("p") || this.user?.homePrefix || "";
    });
  },

  methods: {
    async loadMe() {
      this.authLoading = true;
      const res = await fetch("/api/auth/me");
      const data = await res.json();
      this.user = data.user;
      this.authLoading = false;
      if (this.user) {
        if (!this.cwd && this.user.homePrefix) this.cwd = this.user.homePrefix;
        await this.fetchFiles();
      }
    },
    toggleAuthMode() {
      this.authMode = this.authMode === "login" ? "register" : "login";
      this.message = "";
    },
    async submitAuth() {
      const endpoint = this.authMode === "login" ? "/api/auth/login" : "/api/auth/register";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.authForm),
      });
      const data = await res.json();
      if (!res.ok) {
        this.showMessage(data.error || "操作失败");
        return;
      }
      this.user = data.user;
      this.cwd = this.user.homePrefix || "";
      this.authForm.password = "";
      await this.fetchFiles();
    },
    async logout() {
      await fetch("/api/auth/logout", { method: "POST" });
      this.user = null;
      this.files = [];
      this.folders = [];
      this.cwd = "";
    },
    async fetchFiles() {
      this.loading = true;
      const res = await fetch(`/api/children/${this.cwd}`);
      if (!res.ok) {
        this.loading = false;
        this.showMessage("无法读取当前目录");
        return;
      }
      const data = await res.json();
      this.files = data.value || [];
      this.folders = data.folders || [];
      this.loading = false;
    },
    refresh() {
      this.fetchFiles();
    },
    goUp() {
      this.cwd = this.cwd.replace(/[^/]+\/$/, "");
      if (this.user.homePrefix && !this.cwd.startsWith(this.user.homePrefix)) {
        this.cwd = this.user.homePrefix;
      }
    },
    folderName(folder) {
      return folder.replace(/\/$/, "").split("/").pop() || "/";
    },
    fileName(key) {
      return key.split("/").pop();
    },
    folderLink(folder) {
      return `${window.location.origin}/?p=${encodeURIComponent(folder)}`;
    },
    formatDate(value) {
      return new Date(value).toLocaleString();
    },
    formatSize(size) {
      const units = ["B", "KB", "MB", "GB", "TB"];
      let index = 0;
      let value = size || 0;
      while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
      }
      return `${value.toFixed(1)} ${units[index]}`;
    },
    preview(key) {
      window.open(`/raw/${key}`, "_blank");
    },
    async copyText(text) {
      await navigator.clipboard.writeText(text);
      this.showMessage("已复制");
    },
    promptShareToken() {
      const token = window.prompt("自定义分享后缀，可留空自动生成");
      if (token === null) return null;
      return token.trim();
    },
    async createShare(payload) {
      const customToken = this.promptShareToken();
      if (customToken === null) return null;
      const res = await fetch("/api/shares", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, customToken }),
      });
      const data = await res.json();
      if (!res.ok) return this.showMessage(data.error || "创建分享失败");
      await this.copyText(data.url);
      this.showMessage("分享链接已复制");
      if (this.showShares) await this.loadShares();
      return data;
    },
    async shareFile(key) {
      await this.createShare({ key });
    },
    async loadShares() {
      const res = await fetch("/api/shares");
      if (!res.ok) return this.showMessage("无法读取分享链接");
      const data = await res.json();
      this.shares = data.shares || [];
    },
    shareUrl(share) {
      return `${window.location.origin}/share/${encodeURIComponent(share.token)}`;
    },
    shareLabel(share) {
      if (share.kind === "paste") return `文字 #${share.paste_id}`;
      return share.object_key || "文件";
    },
    async deleteShare(token) {
      if (!window.confirm(`删除分享链接 ${token}？`)) return;
      const res = await fetch(`/api/shares?token=${encodeURIComponent(token)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        return this.showMessage(data.error || "删除分享链接失败");
      }
      this.shares = this.shares.filter((share) => share.token !== token);
      this.showMessage("分享链接已删除");
    },
    async createFolder() {
      const folderName = window.prompt("文件夹名称");
      if (!folderName) return;
      await axios.put(writeItemUrl(`${this.cwd}${folderName}/_$folder$`), "");
      await this.fetchFiles();
    },
    async removeFile(key) {
      if (!window.confirm(`删除 ${key}？`)) return;
      const res = await axios.delete(writeItemUrl(key)).catch((error) => error.response);
      if (!res || res.status >= 400) return this.showMessage("删除失败");
      await this.fetchFiles();
    },
    onUploadPicked(event) {
      const files = Array.from(event.target.files || []);
      event.target.value = "";
      this.uploadFiles(files);
    },
    uploadFiles(files) {
      this.uploadQueue.push(...files.map((file) => ({ basedir: this.cwd, file })));
      if (this.uploadQueue.length) this.processUploadQueue();
    },
    async processUploadQueue() {
      const next = this.uploadQueue.shift();
      if (!next) {
        this.uploadProgress = null;
        await this.fetchFiles();
        return;
      }

      const { basedir, file } = next;
      const headers = {};
      const onUploadProgress = (event) => {
        this.uploadProgress = event.total ? (event.loaded * 100) / event.total : null;
      };

      if (file.type.startsWith("image/") || file.type === "video/mp4") {
        try {
          const thumbnailBlob = await generateThumbnail(file);
          const digestHex = await blobDigest(thumbnailBlob);
          await axios.put(writeItemUrl(`_$flaredrive$/thumbnails/${digestHex}.png`), thumbnailBlob);
          headers["fd-thumbnail"] = digestHex;
        } catch (_) {
          headers["fd-thumbnail"] = "";
        }
      }

      try {
        const key = `${basedir}${file.name}`;
        if (file.size >= SIZE_LIMIT) {
          await multipartUpload(key, file, { headers, onUploadProgress });
        } else {
          await singleUpload(key, file, { headers, onUploadProgress });
        }
      } catch (error) {
        const detail =
          error?.response?.data?.error ||
          error?.response?.data ||
          error?.message ||
          "";
        this.showMessage(`上传失败：${file.name}${detail ? ` (${detail})` : ""}`);
      }
      this.processUploadQueue();
    },
    async loadPastes() {
      const res = await fetch("/api/pastes");
      if (!res.ok) return this.showMessage("无法读取文字暂存");
      const data = await res.json();
      this.pastes = data.pastes || [];
    },
    newPaste() {
      this.pasteEditor = { id: null, title: "", content: "" };
    },
    async editPaste(id) {
      const res = await fetch(`/api/pastes/${id}`);
      const data = await res.json();
      if (!res.ok) return this.showMessage(data.error || "读取失败");
      this.pasteEditor = data.paste;
    },
    async savePaste() {
      const id = this.pasteEditor.id;
      const res = await fetch(id ? `/api/pastes/${id}` : "/api/pastes", {
        method: id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.pasteEditor),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return this.showMessage(data.error || "保存失败");
      if (!id) this.pasteEditor.id = data.id;
      await this.loadPastes();
      this.showMessage("已保存");
    },
    async deletePaste(id) {
      if (!window.confirm("删除这条文字？")) return;
      await fetch(`/api/pastes/${id}`, { method: "DELETE" });
      if (this.pasteEditor.id === id) this.newPaste();
      await this.loadPastes();
    },
    async sharePaste(id) {
      await this.createShare({ pasteId: id });
    },
    showMessage(message) {
      this.message = message;
      window.clearTimeout(this.messageTimer);
      this.messageTimer = window.setTimeout(() => {
        this.message = "";
      }, 2400);
    },
  },
};
</script>

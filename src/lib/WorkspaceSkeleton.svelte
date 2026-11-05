<script lang="ts">
  type Page = 'sale' | 'sales' | 'inventory' | 'expenses' | 'reports' | 'activity';
  let { page = 'sale' }: { page?: Page } = $props();
</script>

<div class="loading-app" role="status" aria-label="Loading your workspace" aria-busy="true">
  <span class="screen-reader-only">Loading your workspace…</span>
  <div class="loading-layout" aria-hidden="true">
    <aside class="loading-rail">
      <span class="skeleton brand"></span>
      <span class="skeleton rail-caption"></span>
      {#each [0, 1, 2, 3, 4, 5] as item}
        <span class:active={item === (page === 'sale' ? 0 : page === 'sales' ? 1 : page === 'inventory' ? 2 : page === 'expenses' ? 3 : page === 'reports' ? 4 : 5)} class="rail-item"><span class="skeleton rail-icon"></span><span class="skeleton rail-label"></span></span>
      {/each}
      <span class="skeleton rail-footer"></span>
    </aside>
    <main class="loading-main">
      <header class="loading-header"><div><span class="skeleton eyebrow"></span><span class="skeleton title"></span></div><span class="skeleton header-status"></span></header>

      {#if page === 'sale'}
        <div class="sale-panels">
          <section class="loading-card"><div class="card-heading"><span class="skeleton heading"></span><span class="skeleton pill"></span></div><span class="skeleton description"></span><span class="skeleton search"></span><div class="column-head"><span class="skeleton short"></span><span class="skeleton short"></span><span class="skeleton short"></span></div>{#each [0, 1, 2, 3, 4] as row}<div class="product-row"><div><span class="skeleton product-name"></span><span class="skeleton product-detail"></span></div><span class="skeleton number"></span><span class="skeleton number"></span></div>{/each}</section>
          <section class="loading-card cart-card"><span class="skeleton heading"></span><div class="column-head"><span class="skeleton short"></span><span class="skeleton short"></span><span class="skeleton short"></span></div>{#each [0, 1, 2] as row}<div class="cart-row"><span class="skeleton product-name"></span><span class="skeleton number"></span><span class="skeleton number"></span></div>{/each}<div class="cart-bottom"><span class="skeleton total"></span><span class="skeleton action"></span></div></section>
        </div>
      {:else if page === 'reports'}
        <section class="loading-card filters-card"><span class="skeleton tabs"></span><div class="filter-row">{#each [0, 1, 2, 3] as field}<span class="skeleton filter"></span>{/each}</div></section>
        <div class="metrics-grid">{#each [0, 1, 2, 3, 4, 5] as card}<section class="loading-card metric-card"><span class="skeleton metric-label"></span><span class="skeleton metric-value"></span><span class="skeleton metric-note"></span></section>{/each}</div>
        <section class="loading-card chart-card"><span class="skeleton heading"></span><span class="skeleton description"></span><div class="chart-bars">{#each [0, 1, 2, 3, 4, 5, 6] as bar}<span class="skeleton chart-bar" style={`height: ${42 + (bar % 3) * 17}%`}></span>{/each}</div></section>
      {:else}
        <section class="loading-card table-card"><div class="card-heading"><span class="skeleton heading"></span><span class="skeleton pill"></span></div><span class="skeleton description"></span>{#if page === 'sales'}<div class="filter-row">{#each [0, 1, 2, 3, 4] as field}<span class="skeleton filter"></span>{/each}</div>{/if}<span class="skeleton results"></span>{#each [0, 1, 2, 3, 4, 5] as row}<div class="table-row"><span class="skeleton table-cell"></span><span class="skeleton table-cell"></span><span class="skeleton table-cell"></span><span class="skeleton table-cell"></span></div>{/each}</section>
      {/if}
    </main>
  </div>
</div>

<style>
  .loading-app{min-height:100vh;background:#f6f7f8;color:#10141b}
  .screen-reader-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
  .loading-layout{display:flex;min-height:100vh}
  .loading-rail{width:252px;flex:none;background:#fff;border-right:1px solid #e4e8ed;padding:24px 16px;display:flex;flex-direction:column;gap:14px}
  .loading-main{min-width:0;flex:1;padding:28px 32px 40px}
  .skeleton{display:block;border-radius:7px;background:linear-gradient(100deg,#edf0f3 25%,#f7f8fa 45%,#edf0f3 65%);background-size:220% 100%;animation:shimmer 1.5s ease-in-out infinite}
  .brand{width:42px;height:42px;background:#e4e8ed;margin-bottom:30px}
  .rail-caption{width:82px;height:11px;margin:0 8px 10px}
  .rail-item{height:46px;border-radius:9px;display:flex;align-items:center;gap:14px;padding:0 12px}
  .rail-item.active{background:#edf3ff}.rail-item.active .skeleton{background:#d5e5ff;animation:none}
  .rail-icon{height:19px;width:19px;flex:none}.rail-label{height:14px;width:92px}.rail-footer{height:14px;width:110px;margin:auto 8px 6px}
  .loading-header{min-height:104px;display:flex;justify-content:space-between;align-items:flex-start;gap:24px}.loading-header>div{display:grid;gap:12px}
  .eyebrow{width:176px;height:10px}.title{width:154px;height:30px}.header-status{width:280px;height:36px;border-radius:18px}
  .sale-panels{display:grid;grid-template-columns:1fr 1fr;gap:18px;min-height:640px}.loading-card{background:#fff;border:1px solid #e1e4e8;border-radius:14px;padding:27px;min-width:0}
  .card-heading{display:flex;justify-content:space-between;gap:16px;align-items:center}.heading{width:160px;height:22px}.pill{width:72px;height:30px;border-radius:18px}.description{width:230px;max-width:90%;height:13px;margin-top:14px}.search{width:100%;height:52px;margin-top:28px}
  .column-head{display:flex;justify-content:space-between;gap:14px;margin-top:28px;padding:0 0 19px;border-bottom:1px solid #edf0f3}.short{height:13px;width:72px}
  .product-row,.cart-row,.table-row{display:flex;justify-content:space-between;align-items:center;gap:20px;border-bottom:1px solid #edf0f3}.product-row{min-height:79px}.product-row>div{flex:1}.product-name{width:126px;max-width:90%;height:16px}.product-detail{width:90px;height:11px;margin-top:10px}.number{width:72px;height:16px}
  .cart-row{min-height:86px}.cart-card{display:flex;flex-direction:column}.cart-bottom{margin-top:auto;padding-top:24px;border-top:1px solid #edf0f3}.total{height:25px;width:42%;margin-bottom:24px}.action{height:50px;width:100%}
  .filters-card{padding:24px 27px}.tabs{width:254px;height:18px}.filter-row{display:flex;gap:14px;margin-top:25px}.filter{height:44px;flex:1;min-width:0}
  .metrics-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin-top:16px}.metric-card{min-height:154px}.metric-label{height:13px;width:110px}.metric-value{height:28px;width:55%;margin-top:24px}.metric-note{height:12px;width:65%;margin-top:17px}
  .chart-card{margin-top:17px}.chart-bars{height:230px;display:flex;align-items:end;justify-content:space-around;gap:25px;border-bottom:1px solid #edf0f3;padding:25px 5% 0}.chart-bar{width:34px;max-height:100%;border-radius:5px 5px 0 0}
  .table-card{min-height:650px}.results{width:100px;height:12px;margin:27px 0 5px}.table-row{min-height:74px}.table-cell{height:14px;width:18%}
  @keyframes shimmer{to{background-position-x:-220%}}
  @media(max-width:850px){.loading-rail{width:64px;padding:20px 8px}.loading-rail .rail-caption,.loading-rail .rail-label,.loading-rail .rail-footer{display:none}.rail-item{justify-content:center;padding:0}.loading-main{padding:22px 18px}.sale-panels{grid-template-columns:1fr}.metrics-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
  @media(max-width:600px){.loading-rail{width:54px}.loading-main{padding:18px 10px}.loading-header{min-height:82px}.header-status{width:90px}.title{width:100px;height:23px}.eyebrow{width:120px}.loading-card{padding:18px 14px}.metrics-grid{grid-template-columns:1fr 1fr;gap:10px}.metric-card{min-height:124px}.metric-value{height:22px}.filter-row{flex-wrap:wrap}.filter{flex:1 1 40%}.chart-bars{height:165px;gap:8px}.chart-bar{width:20px}.table-cell{width:20%}}
  @media(prefers-reduced-motion:reduce){.skeleton{animation:none}}
</style>

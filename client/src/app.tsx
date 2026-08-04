import React from 'react';
import { Route, Routes } from 'react-router-dom';

import Layout from './components/Layout';
import NotFound from './pages/NotFound/NotFound';
import TodayHot from './pages/TodayHot/TodayHot';
import Workbench from './pages/Workbench/Workbench';
import SourceManage from './pages/SourceManage/SourceManage';
import GithubTrendingPage from './pages/Trending/GithubTrendingPage';
import WeiboHotPage from './pages/Trending/WeiboHotPage';

const RoutesComponent = () => {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<TodayHot />} />
        <Route path="trending/github" element={<GithubTrendingPage />} />
        <Route path="trending/weibo" element={<WeiboHotPage />} />
        <Route path="workbench" element={<Workbench />} />
        <Route path="sources" element={<SourceManage />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
};

export default RoutesComponent;

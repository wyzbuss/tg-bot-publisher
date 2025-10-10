// api/test404.js（仅用于测试路径是否生效）
module.exports = async (req, res) => {
  res.status(200).json({ message: "test404 函数生效了！！" });
};
module.exports.config = { runtime: "nodejs" };

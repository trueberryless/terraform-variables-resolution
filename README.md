# 👀 Terraform Variables Resolution

> Vibe-Coded Project, no tests - Use at your own risk or trust [Claude](https://www.anthropic.com/claude), bro!

> **Resolve local terraform variables recursively and display them as inlay text besides your variables** - VS Code Extension

[![View on Marketplace](https://img.shields.io/badge/View_on-Marketplace-blue)](https://marketplace.visualstudio.com/items?itemName=trueberryless.terraform-variables-resolution)

## ✨ Features

- 🚀 **Fast development** - Immediately see the value behind the variable besides it like in Rider
- 🎯 **Multiple variants** - Displays all variants of variables if module is used more than once
- 🔄 **Cache Management** - Intelligent caching to avoid redundant resolutions

## 📚 Resources

- ✍️ [**Blog Post (WIP)**]() - Not yet published

## 🔧 How It Works

This VS Code Extension analyzes your project with these steps to help you write Terraform code:

1. **📄 Parse** - Parse Terraform code
2. **🔍 Analyze** - Look for module variables in whole project
3. **💾 Cache** - Save resolutions for future incremental updates
4. **👀 Display** - Visualize the values after the variable name

## ⚙️ Configuration

### 📝 Basic Settings

| Parameter                   | Description                     | Default |
| --------------------------- | ------------------------------- | ------- |
| `terraformResolver.enabled` | Enable or disable the extension | `true`  |

<div align="center">

**Made with [Claude](https://www.anthropic.com/claude) by [trueberryless](https://trueberryless.org)**

</div>

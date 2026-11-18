# what's "OTCL"?

**OTCL** 是 **Opends Tool Call Language** 的意思

它是**opends**系列项目的模型专用工具调用语言，目的是让deepseek模型像写Javascript代码一样去调用工具，避免明显的工具调用特征导致的禁言/封号问题

# 基本语法

**OTCL**的语法非常简单，就像javascript一样

**示例：**

假设有一个叫做executeShell的工具函数

```otcl
executeShell({command:"ls",timeout:10});
```

可以发现与**javascript**的语法基本一样，甚至连命名规范都一致

调用每个工具函数传参都需要用Javascript对象包起来

## 如何给模型提供一个工具函数

很简单，就像在**Javascript**定义一个函数一样，并且函数体不需要具体代码逻辑

```otcl

function executeShell(pars)
{
\*这里是参数定义及描述*\
}

```
